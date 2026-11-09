import type {
  ConflictReport,
  ConstraintCode,
  DayOfWeek,
  ScheduleAssignment,
} from "../../types/schedule";
import type {
  ConstraintContext,
  RuleEvaluationResult,
  SoftConstraintRule,
} from "./types";

function slotKey(day: string, period: number): string {
  return `${day}_P${period}`;
}

function makeSoftConflict(
  code: ConstraintCode,
  message: string,
  assignmentIds: string[],
  penalty: number,
  entityIds?: ConflictReport["entityIds"]
): ConflictReport {
  return {
    id: `${code}:${assignmentIds.slice().sort().join("+")}:${message.length}`,
    code,
    severity: "SOFT",
    message,
    assignmentIds,
    entityIds,
    penalty,
  };
}

function softResult(
  conflicts: ConflictReport[],
  penalty: number
): RuleEvaluationResult {
  return {
    satisfied: penalty === 0 && conflicts.length === 0,
    conflicts,
    penalty,
  };
}

function groupByDay(
  assignments: ScheduleAssignment[]
): Map<DayOfWeek, ScheduleAssignment[]> {
  const map = new Map<DayOfWeek, ScheduleAssignment[]>();
  for (const a of assignments) {
    const list = map.get(a.timeSlot.day) ?? [];
    list.push(a);
    map.set(a.timeSlot.day, list);
  }
  for (const list of map.values()) {
    list.sort((x, y) => x.timeSlot.period - y.timeSlot.period);
  }
  return map;
}

/**
 * S1 — Penalize runs of consecutive periods for a class group
 * longer than `maxConsecutive` (default 3).
 */
export class MaxConsecutiveHoursRule implements SoftConstraintRule {
  readonly code = "S1" as const;
  readonly name = "Max Consecutive Hours";
  readonly description = "ห้ามเรียนติดต่อกันเกิน X คาบ";
  readonly severity = "SOFT" as const;
  readonly weight: number;
  readonly maxConsecutive: number;

  constructor(maxConsecutive = 3, weight = 2) {
    this.maxConsecutive = maxConsecutive;
    this.weight = weight;
  }

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    let penalty = 0;

    const byGroup = new Map<string, ScheduleAssignment[]>();
    for (const a of context.assignments) {
      const list = byGroup.get(a.classGroupId) ?? [];
      list.push(a);
      byGroup.set(a.classGroupId, list);
    }

    for (const [classGroupId, assignments] of byGroup) {
      const byDay = groupByDay(assignments);
      const group = context.classGroupsById.get(classGroupId);

      for (const [day, dayAssignments] of byDay) {
        let runStart = 0;
        for (let i = 1; i <= dayAssignments.length; i++) {
          const isBreak =
            i === dayAssignments.length ||
            dayAssignments[i].timeSlot.period !==
              dayAssignments[i - 1].timeSlot.period + 1;

          if (!isBreak) continue;

          const run = dayAssignments.slice(runStart, i);
          const overflow = run.length - this.maxConsecutive;
          if (overflow > 0) {
            penalty += overflow;
            conflicts.push(
              makeSoftConflict(
                "S1",
                `Group "${group?.groupName ?? classGroupId}" has ${run.length} consecutive periods on ${day} (max ${this.maxConsecutive})`,
                run.map((a) => a.id),
                overflow,
                { classGroupId }
              )
            );
          }
          runStart = i;
        }
      }
    }

    return softResult(conflicts, penalty);
  }
}

/**
 * S2 — Penalize room changes between consecutive periods
 * for the same class group on the same day.
 */
export class RoomChangeMinimizationRule implements SoftConstraintRule {
  readonly code = "S2" as const;
  readonly name = "Room Change Minimization";
  readonly description = "ลดการเปลี่ยนห้องบ่อยในวันเดียวกัน";
  readonly severity = "SOFT" as const;
  readonly weight: number;

  constructor(weight = 1.5) {
    this.weight = weight;
  }

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    let penalty = 0;

    const byGroup = new Map<string, ScheduleAssignment[]>();
    for (const a of context.assignments) {
      const list = byGroup.get(a.classGroupId) ?? [];
      list.push(a);
      byGroup.set(a.classGroupId, list);
    }

    for (const [classGroupId, assignments] of byGroup) {
      const byDay = groupByDay(assignments);
      const group = context.classGroupsById.get(classGroupId);

      for (const [day, dayAssignments] of byDay) {
        for (let i = 1; i < dayAssignments.length; i++) {
          const prev = dayAssignments[i - 1];
          const curr = dayAssignments[i];
          const consecutive =
            curr.timeSlot.period === prev.timeSlot.period + 1;
          if (!consecutive || prev.roomId === curr.roomId) continue;

          penalty += 1;
          conflicts.push(
            makeSoftConflict(
              "S2",
              `Group "${group?.groupName ?? classGroupId}" changes rooms between P${prev.timeSlot.period} and P${curr.timeSlot.period} on ${day}`,
              [prev.id, curr.id],
              1,
              { classGroupId, roomId: curr.roomId }
            )
          );
        }
      }
    }

    return softResult(conflicts, penalty);
  }
}

/**
 * S3 — Penalize uneven teacher weekly workloads
 * (sum of absolute deviations from the mean hours).
 */
export class TeacherWorkloadBalanceRule implements SoftConstraintRule {
  readonly code = "S3" as const;
  readonly name = "Teacher Workload Balance";
  readonly description = "กระจายภาระงานครูให้สมดุล";
  readonly severity = "SOFT" as const;
  readonly weight: number;

  constructor(weight = 1) {
    this.weight = weight;
  }

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const hoursByTeacher = new Map<string, number>();
    const idsByTeacher = new Map<string, string[]>();

    for (const teacher of context.input.teachers) {
      hoursByTeacher.set(teacher.id, 0);
      idsByTeacher.set(teacher.id, []);
    }

    for (const a of context.assignments) {
      hoursByTeacher.set(a.teacherId, (hoursByTeacher.get(a.teacherId) ?? 0) + 1);
      const ids = idsByTeacher.get(a.teacherId) ?? [];
      ids.push(a.id);
      idsByTeacher.set(a.teacherId, ids);
    }

    const hours = [...hoursByTeacher.values()];
    if (hours.length === 0) return softResult([], 0);

    const mean = hours.reduce((sum, h) => sum + h, 0) / hours.length;
    const conflicts: ConflictReport[] = [];
    let penalty = 0;

    for (const [teacherId, load] of hoursByTeacher) {
      const deviation = Math.abs(load - mean);
      if (deviation < 0.5) continue;

      const rounded = Math.round(deviation * 10) / 10;
      penalty += rounded;
      const teacher = context.teachersById.get(teacherId);
      conflicts.push(
        makeSoftConflict(
          "S3",
          `Teacher "${teacher?.name ?? teacherId}" load ${load}h differs from mean ${mean.toFixed(1)}h by ${rounded}`,
          idsByTeacher.get(teacherId) ?? [],
          rounded,
          { teacherId }
        )
      );
    }

    return softResult(conflicts, penalty);
  }
}

/**
 * S4 — Prefer compact day packing for class groups (minimize scattered idle gaps).
 * Unavailable slots / maxHoursPerDay are HARD (H6/H7) and no longer soft-penalized here.
 */
export class IdleGapMinimizationRule implements SoftConstraintRule {
  readonly code = "S4" as const;
  readonly name = "Idle Gap Minimization";
  readonly description = "ลดคาบว่างกระจายในวันเดียวกันของกลุ่มเรียน";
  readonly severity = "SOFT" as const;
  readonly weight: number;

  constructor(weight = 1.5) {
    this.weight = weight;
  }

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    let penalty = 0;

    const byGroup = new Map<string, ScheduleAssignment[]>();
    for (const a of context.assignments) {
      const list = byGroup.get(a.classGroupId) ?? [];
      list.push(a);
      byGroup.set(a.classGroupId, list);
    }

    for (const [classGroupId, assignments] of byGroup) {
      const byDay = groupByDay(assignments);
      const group = context.classGroupsById.get(classGroupId);

      for (const [day, dayAssignments] of byDay) {
        if (dayAssignments.length < 2) continue;
        let gaps = 0;
        for (let i = 1; i < dayAssignments.length; i++) {
          const delta =
            dayAssignments[i]!.timeSlot.period -
            dayAssignments[i - 1]!.timeSlot.period;
          if (delta > 1) gaps += delta - 1;
        }
        if (gaps <= 0) continue;
        penalty += gaps;
        conflicts.push(
          makeSoftConflict(
            "S4",
            `Group "${group?.groupName ?? classGroupId}" has ${gaps} idle gap(s) on ${day}`,
            dayAssignments.map((a) => a.id),
            gaps,
            { classGroupId }
          )
        );
      }
    }

    return softResult(conflicts, penalty);
  }
}

export const softRules: SoftConstraintRule[] = [
  new MaxConsecutiveHoursRule(),
  new RoomChangeMinimizationRule(),
  new TeacherWorkloadBalanceRule(),
  new IdleGapMinimizationRule(),
];
