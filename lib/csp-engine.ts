import {
  checkHardConstraints,
  recomputeScheduleMetrics,
} from "../engine/solver";
import type {
  DayOfWeek,
  ScheduleAssignment,
  ScheduleInput,
  ScheduleResult,
} from "../types/schedule";
import type { AgentConstraint } from "./agentSchema";

const DYNAMIC_TIMEOUT_MS = 500;

export type DynamicApplySuccess = {
  ok: true;
  result: ScheduleResult;
  message: string;
  appliedAction: AgentConstraint["action"];
};

export type DynamicApplyFailure = {
  ok: false;
  error: string;
  code: "TIMEOUT" | "HARD_CONFLICT" | "NO_CANDIDATE" | "NOT_FOUND" | "INVALID";
  rolledBack: true;
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
 * Accepts ONLY zero-hard-conflict outcomes within a 500ms budget; otherwise rolls back.
 */
export function applyDynamicConstraintSafely(
  input: ScheduleInput,
  current: ScheduleResult,
  constraint: AgentConstraint
): DynamicApplyOutcome {
  const snapshot = cloneAssignments(current.assignments);
  const draft = cloneAssignments(current.assignments);

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
      return { ...mutated, rolledBack: true };
    }

    const check = checkHardConstraints(input, draft);
    if (!check.ok || check.hardConflictCount > 0) {
      return {
        ok: false,
        error:
          "การแก้ไขทำให้เกิดข้อขัดแย้งแข็ง — ระบบย้อนกลับสถานะเดิมแล้ว",
        code: "HARD_CONFLICT",
        rolledBack: true,
      };
    }

    const result = recomputeScheduleMetrics(
      input,
      draft,
      current.seed,
      current.executionTimeMs
    );

    if (result.hardConflictCount > 0) {
      return {
        ok: false,
        error:
          "ผลลัพธ์มีข้อขัดแย้งแข็ง — ระบบย้อนกลับสถานะเดิมแล้ว",
        code: "HARD_CONFLICT",
        rolledBack: true,
      };
    }

    return {
      ok: true,
      result,
      message: mutated.message,
      appliedAction: constraint.action,
    };
  } catch (err) {
    const timedOut =
      err instanceof Error &&
      (err.message === "CSP_TIMEOUT" ||
        (err as Error & { code?: string }).code === "TIMEOUT");
    // Explicit rollback reference (draft discarded; caller keeps snapshot)
    void snapshot;
    return {
      ok: false,
      error: timedOut
        ? "การค้นหาเกินเวลา 500ms — ระบบย้อนกลับสถานะเดิมแล้ว"
        : "เกิดข้อผิดพลาดระหว่างคำนวณ — ระบบย้อนกลับสถานะเดิมแล้ว",
      code: timedOut ? "TIMEOUT" : "INVALID",
      rolledBack: true,
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
        teacher.unavailableSlots.includes(
          `${constraint.day}_P${constraint.period}`
        )
      ) {
        return false;
      }
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
export { solveSchedule, checkHardConstraints, recomputeScheduleMetrics } from "../engine/solver";
