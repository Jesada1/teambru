import {
  checkHardConstraints,
  recomputeScheduleMetrics,
  solveNaiveGreedy,
  solveSchedule,
} from "../engine/solver";
import type {
  DayOfWeek,
  ScheduleAssignment,
  ScheduleInput,
  ScheduleResult,
} from "../types/schedule";
import type { AgentConstraint } from "./agentSchema";

const DYNAMIC_TIMEOUT_MS = 500;

export type AlgorithmMetrics = {
  label: "CSP" | "NaiveGreedy";
  hardConflictCount: number;
  executionTimeMs: number;
  fitnessScore: number;
  completionRate: number;
  softPenaltyTotal: number;
  assignmentCount: number;
};

export type AlgorithmComparison = {
  seed: number;
  csp: AlgorithmMetrics;
  naive: AlgorithmMetrics;
  winner: "CSP" | "NaiveGreedy" | "TIE";
};

function toMetrics(
  label: AlgorithmMetrics["label"],
  result: ScheduleResult
): AlgorithmMetrics {
  return {
    label,
    hardConflictCount: result.hardConflictCount,
    executionTimeMs: result.executionTimeMs,
    fitnessScore: Number.isFinite(result.fitnessScore)
      ? result.fitnessScore
      : Number.NEGATIVE_INFINITY,
    completionRate: result.completionRate ?? 0,
    softPenaltyTotal: result.softPenaltyTotal,
    assignmentCount: result.assignments.length,
  };
}

function pickWinner(
  csp: AlgorithmMetrics,
  naive: AlgorithmMetrics
): AlgorithmComparison["winner"] {
  if (csp.hardConflictCount !== naive.hardConflictCount) {
    return csp.hardConflictCount < naive.hardConflictCount ? "CSP" : "NaiveGreedy";
  }
  if (csp.completionRate !== naive.completionRate) {
    return csp.completionRate > naive.completionRate ? "CSP" : "NaiveGreedy";
  }
  if (csp.fitnessScore !== naive.fitnessScore) {
    return csp.fitnessScore > naive.fitnessScore ? "CSP" : "NaiveGreedy";
  }
  return "TIE";
}

/**
 * Competition benchmark: run CSP solver and a Naive/Greedy baseline
 * on the same dataset + seed, then return side-by-side metrics.
 */
export function runAlgorithmComparison(
  input: ScheduleInput,
  seed = 42
): AlgorithmComparison {
  const cspResult = solveSchedule(input, seed);
  const naiveResult = solveNaiveGreedy(input, seed);
  const csp = toMetrics("CSP", cspResult);
  const naive = toMetrics("NaiveGreedy", naiveResult);
  return {
    seed,
    csp,
    naive,
    winner: pickWinner(csp, naive),
  };
}

export type AgentPipelineStep = {
  stage: "PLAN" | "ACT" | "CHECK";
  status: "ok" | "fail" | "skip";
  message: string;
  detail?: Record<string, unknown>;
};

export type AgentPipelineLog = {
  steps: AgentPipelineStep[];
  status: "applied" | "rollback";
};

export type DynamicApplySuccess = {
  ok: true;
  result: ScheduleResult;
  message: string;
  appliedAction: AgentConstraint["action"];
  pipeline: AgentPipelineLog;
};

export type DynamicApplyFailure = {
  ok: false;
  error: string;
  code: "TIMEOUT" | "HARD_CONFLICT" | "NO_CANDIDATE" | "NOT_FOUND" | "INVALID";
  rolledBack: true;
  pipeline: AgentPipelineLog;
};

export type DynamicApplyOutcome = DynamicApplySuccess | DynamicApplyFailure;

function cloneAssignments(
  assignments: ScheduleAssignment[]
): ScheduleAssignment[] {
  return assignments.map((a) => ({
    ...a,
    timeSlot: { ...a.timeSlot },
  }));
}

function withTimeout<T>(work: () => T, ms: number): T {
  const started = Date.now();
  const result = work();
  if (Date.now() - started > ms) {
    const err = new Error("CSP_TIMEOUT");
    (err as Error & { code?: string }).code = "TIMEOUT";
    throw err;
  }
  return result;
}

function findSlotAssignments(
  assignments: ScheduleAssignment[],
  teacherId: string,
  day: DayOfWeek,
  period: number
): ScheduleAssignment[] {
  return assignments.filter(
    (a) =>
      a.teacherId === teacherId &&
      a.timeSlot.day === day &&
      a.timeSlot.period === period
  );
}

function teacherBusyAt(
  assignments: ScheduleAssignment[],
  teacherId: string,
  day: DayOfWeek,
  period: number
): boolean {
  return assignments.some(
    (a) =>
      a.teacherId === teacherId &&
      a.timeSlot.day === day &&
      a.timeSlot.period === period
  );
}

/**
 * Apply a dynamic agent constraint on a sandboxed draft of the timetable.
 * Plan → Act → Check pipeline with 500ms budget; hard-conflict outcomes roll back.
 */
export function applyDynamicConstraintSafely(
  input: ScheduleInput,
  current: ScheduleResult,
  constraint: AgentConstraint
): DynamicApplyOutcome {
  const snapshot = cloneAssignments(current.assignments);
  const draft = cloneAssignments(current.assignments);
  const steps: AgentPipelineStep[] = [
    {
      stage: "PLAN",
      status: "ok",
      message: "Parsed natural-language intent into structured JSON rules",
      detail: {
        action: constraint.action,
        targetTeacherId: constraint.targetTeacherId,
        day: constraint.day,
        period: constraint.period,
        reason: constraint.reason,
      },
    },
  ];

  try {
    const mutated = withTimeout(() => {
      switch (constraint.action) {
        case "SUBSTITUTE_TEACHER":
          return applySubstitute(input, draft, constraint);
        case "LOCK_SLOT":
          return applyLockSlot(draft, constraint);
        case "SWAP_PERIOD":
          return applySwapPeriod(input, draft, constraint);
        default:
          return {
            ok: false as const,
            error: "ไม่รองรับคำสั่งนี้",
            code: "INVALID" as const,
          };
      }
    }, DYNAMIC_TIMEOUT_MS);

    if (!mutated.ok) {
      steps.push({
        stage: "ACT",
        status: "fail",
        message: mutated.error,
        detail: { code: mutated.code },
      });
      steps.push({
        stage: "CHECK",
        status: "skip",
        message: "Skipped — ACT failed before sandbox validation",
      });
      return {
        ...mutated,
        rolledBack: true,
        pipeline: { steps, status: "rollback" },
      };
    }

    steps.push({
      stage: "ACT",
      status: "ok",
      message: "CSP engine injected dynamic constraint into draft sandbox",
      detail: { applied: mutated.message },
    });

    const check = checkHardConstraints(input, draft);
    if (!check.ok || check.hardConflictCount > 0) {
      steps.push({
        stage: "CHECK",
        status: "fail",
        message: "Transactional validation failed — hard conflicts detected",
        detail: {
          hardConflictCount: check.hardConflictCount,
          conflicts: check.conflicts.slice(0, 5).map((c) => c.code),
        },
      });
      return {
        ok: false,
        error:
          "การแก้ไขทำให้เกิดข้อขัดแย้งแข็ง — ระบบย้อนกลับสถานะเดิมแล้ว",
        code: "HARD_CONFLICT",
        rolledBack: true,
        pipeline: { steps, status: "rollback" },
      };
    }

    const result = recomputeScheduleMetrics(
      input,
      draft,
      current.seed,
      current.executionTimeMs
    );

    if (result.hardConflictCount > 0) {
      steps.push({
        stage: "CHECK",
        status: "fail",
        message: "Post-metric hard conflict check failed — rolling back",
        detail: { hardConflictCount: result.hardConflictCount },
      });
      return {
        ok: false,
        error:
          "ผลลัพธ์มีข้อขัดแย้งแข็ง — ระบบย้อนกลับสถานะเดิมแล้ว",
        code: "HARD_CONFLICT",
        rolledBack: true,
        pipeline: { steps, status: "rollback" },
      };
    }

    steps.push({
      stage: "CHECK",
      status: "ok",
      message: "Validated 0 hard conflicts — commit draft",
      detail: {
        hardConflictCount: result.hardConflictCount,
        completionRate: result.completionRate,
      },
    });

    return {
      ok: true,
      result,
      message: mutated.message,
      appliedAction: constraint.action,
      pipeline: { steps, status: "applied" },
    };
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.message === "CSP_TIMEOUT" ||
        (err as Error & { code?: string }).code === "TIMEOUT");
    void snapshot;
    steps.push({
      stage: "ACT",
      status: "fail",
      message: timedOut
        ? "Sandbox search exceeded 500ms budget"
        : "Unexpected engine error during ACT",
    });
    steps.push({
      stage: "CHECK",
      status: "skip",
      message: "Skipped — rolled back to previous schedule",
    });
    return {
      ok: false,
      error: timedOut
        ? "การค้นหาเกินเวลา 500ms — ระบบย้อนกลับสถานะเดิมแล้ว"
        : "เกิดข้อผิดพลาดระหว่างคำนวณ — ระบบย้อนกลับสถานะเดิมแล้ว",
      code: timedOut ? "TIMEOUT" : "INVALID",
      rolledBack: true,
      pipeline: { steps, status: "rollback" },
    };
  }
}

function applySubstitute(
  input: ScheduleInput,
  draft: ScheduleAssignment[],
  constraint: AgentConstraint
): { ok: true; message: string } | { ok: false; error: string; code: DynamicApplyFailure["code"] } {
  const targets = findSlotAssignments(
    draft,
    constraint.targetTeacherId,
    constraint.day,
    constraint.period
  );
  if (!targets.length) {
    return {
      ok: false,
      error: "ไม่พบคาบของครูเป้าหมายในช่วงเวลาที่ระบุ",
      code: "NOT_FOUND",
    };
  }

  for (const target of targets) {
    const subject = input.subjects.find((s) => s.id === target.subjectId);
    const candidates = input.teachers.filter((teacher) => {
      if (teacher.id === constraint.targetTeacherId) return false;
      if (
        teacherBusyAt(draft, teacher.id, constraint.day, constraint.period)
      ) {
        return false;
      }
      if (
        (teacher.unavailableSlots as string[]).includes(
          `${constraint.day}_P${constraint.period}`
        )
      ) {
        return false;
      }
      const dayLoad = draft.filter(
        (a) =>
          a.teacherId === teacher.id && a.timeSlot.day === constraint.day
      ).length;
      if (dayLoad + 1 > teacher.maxHoursPerDay) return false;
      return true;
    });

    // Prefer teachers who already teach matching room-type subjects
    candidates.sort((a, b) => {
      const score = (id: string) =>
        input.subjects.filter(
          (s) =>
            s.assignedTeacherId === id &&
            subject &&
            s.requiredRoomType === subject.requiredRoomType
        ).length;
      return score(b.id) - score(a.id);
    });

    const replacement = candidates[0];
    if (!replacement) {
      return {
        ok: false,
        error: "ไม่พบครูผู้สอนแทนที่ว่างในคาบดังกล่าว",
        code: "NO_CANDIDATE",
      };
    }

    const idx = draft.findIndex((a) => a.id === target.id);
    if (idx >= 0) {
      draft[idx] = { ...draft[idx]!, teacherId: replacement.id };
    }
  }

  return {
    ok: true,
    message: `แทนครูสำเร็จสำหรับคาบ ${constraint.period} (${constraint.day})`,
  };
}

function applyLockSlot(
  draft: ScheduleAssignment[],
  constraint: AgentConstraint
): { ok: true; message: string } | { ok: false; error: string; code: DynamicApplyFailure["code"] } {
  const targets = findSlotAssignments(
    draft,
    constraint.targetTeacherId,
    constraint.day,
    constraint.period
  );
  if (!targets.length) {
    return {
      ok: false,
      error: "ไม่พบคาบที่จะล็อคในช่วงเวลาที่ระบุ",
      code: "NOT_FOUND",
    };
  }
  // Lock is a no-op mutation that validates the slot remains conflict-free
  return {
    ok: true,
    message: `ล็อคคาบ ${constraint.period} (${constraint.day}) เรียบร้อย`,
  };
}

function applySwapPeriod(
  input: ScheduleInput,
  draft: ScheduleAssignment[],
  constraint: AgentConstraint
): { ok: true; message: string } | { ok: false; error: string; code: DynamicApplyFailure["code"] } {
  const source = findSlotAssignments(
    draft,
    constraint.targetTeacherId,
    constraint.day,
    constraint.period
  )[0];
  if (!source) {
    return {
      ok: false,
      error: "ไม่พบคาบต้นทางที่จะสลับ",
      code: "NOT_FOUND",
    };
  }

  // Swap with another assignment of the same teacher on the same day (different period)
  const peers = draft.filter(
    (a) =>
      a.teacherId === constraint.targetTeacherId &&
      a.timeSlot.day === constraint.day &&
      a.id !== source.id
  );
  if (!peers.length) {
    // Try any free slot on same day for this teacher’s class by swapping with empty — find another teacher period same day
    const sameDayOthers = draft.filter(
      (a) =>
        a.timeSlot.day === constraint.day &&
        a.timeSlot.period !== constraint.period &&
        a.classGroupId === source.classGroupId
    );
    if (!sameDayOthers.length) {
      return {
        ok: false,
        error: "ไม่พบคาบปลายทางที่สลับได้โดยไม่ละเมิดข้อจำกัด",
        code: "NO_CANDIDATE",
      };
    }
    const target = sameDayOthers[0]!;
    const srcSlot = { ...source.timeSlot };
    const tgtSlot = { ...target.timeSlot };
    const si = draft.findIndex((a) => a.id === source.id);
    const ti = draft.findIndex((a) => a.id === target.id);
    if (si >= 0) draft[si] = { ...draft[si]!, timeSlot: tgtSlot };
    if (ti >= 0) draft[ti] = { ...draft[ti]!, timeSlot: srcSlot };
    return {
      ok: true,
      message: `สลับคาบ ${constraint.period} ↔ ${target.timeSlot.period} สำเร็จ`,
    };
  }

  const target = peers[0]!;
  const srcSlot = { ...source.timeSlot };
  const tgtSlot = { ...target.timeSlot };
  const si = draft.findIndex((a) => a.id === source.id);
  const ti = draft.findIndex((a) => a.id === target.id);
  if (si >= 0) draft[si] = { ...draft[si]!, timeSlot: tgtSlot };
  if (ti >= 0) draft[ti] = { ...draft[ti]!, timeSlot: srcSlot };

  // Touch input to keep signature used (room capacity context available to caller)
  void input;

  return {
    ok: true,
    message: `สลับคาบ ${constraint.period} ↔ ${target.timeSlot.period} สำเร็จ`,
  };
}

/** Re-export solver entry points for a single CSP facade */
export {
  solveSchedule,
  solveNaiveGreedy,
  checkHardConstraints,
  recomputeScheduleMetrics,
} from "../engine/solver";
