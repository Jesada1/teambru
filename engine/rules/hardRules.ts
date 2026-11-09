import type { ConflictReport, ConstraintCode } from "../../types/schedule";
import type {
  ConstraintContext,
  HardConstraintRule,
  RuleEvaluationResult,
} from "./types";

function slotKey(day: string, period: number): string {
  return `${day}_P${period}`;
}

function makeConflict(
  code: ConstraintCode,
  message: string,
  assignmentIds: string[],
  entityIds?: ConflictReport["entityIds"]
): ConflictReport {
  return {
    id: `${code}:${assignmentIds.slice().sort().join("+")}`,
    code,
    severity: "HARD",
    message,
    assignmentIds,
    entityIds,
    penalty: 0,
  };
}

function emptyHardResult(conflicts: ConflictReport[]): RuleEvaluationResult {
  return {
    satisfied: conflicts.length === 0,
    conflicts,
    penalty: 0,
  };
}

/** H1 — Teacher cannot teach more than one class in the same time slot */
export class TeacherOverlapRule implements HardConstraintRule {
  readonly code = "H1" as const;
  readonly name = "Teacher Overlap";
  readonly description = "ครูห้ามสอนซ้อนคาบ";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const byTeacherSlot = new Map<string, string[]>();

    for (const a of context.assignments) {
      const key = `${a.teacherId}|${slotKey(a.timeSlot.day, a.timeSlot.period)}`;
      const list = byTeacherSlot.get(key) ?? [];
      list.push(a.id);
      byTeacherSlot.set(key, list);
    }

    const conflicts: ConflictReport[] = [];
    for (const [key, ids] of byTeacherSlot) {
      if (ids.length < 2) continue;
      const teacherId = key.split("|")[0];
      const teacher = context.teachersById.get(teacherId);
      conflicts.push(
        makeConflict(
          "H1",
          `Teacher "${teacher?.name ?? teacherId}" has overlapping assignments`,
          ids,
          { teacherId }
        )
      );
    }

    return emptyHardResult(conflicts);
  }
}

/** H2 — Room cannot host more than one class in the same time slot */
export class RoomOverlapRule implements HardConstraintRule {
  readonly code = "H2" as const;
  readonly name = "Room Overlap";
  readonly description = "ห้องเรียนห้ามใช้ซ้ำเวลาเดียวกัน";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const byRoomSlot = new Map<string, string[]>();

    for (const a of context.assignments) {
      const key = `${a.roomId}|${slotKey(a.timeSlot.day, a.timeSlot.period)}`;
      const list = byRoomSlot.get(key) ?? [];
      list.push(a.id);
      byRoomSlot.set(key, list);
    }

    const conflicts: ConflictReport[] = [];
    for (const [key, ids] of byRoomSlot) {
      if (ids.length < 2) continue;
      const roomId = key.split("|")[0];
      const room = context.roomsById.get(roomId);
      conflicts.push(
        makeConflict(
          "H2",
          `Room "${room?.name ?? roomId}" is double-booked`,
          ids,
          { roomId }
        )
      );
    }

    return emptyHardResult(conflicts);
  }
}

/**
 * H3 — Class group (and its parallel groups) cannot attend
 * more than one class in the same time slot
 */
export class ClassGroupOverlapRule implements HardConstraintRule {
  readonly code = "H3" as const;
  readonly name = "ClassGroup Overlap";
  readonly description = "กลุ่มเรียนห้ามมีเรียนซ้อนกัน";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    const byGroupSlot = new Map<string, typeof context.assignments>();

    for (const a of context.assignments) {
      const key = `${a.classGroupId}|${slotKey(a.timeSlot.day, a.timeSlot.period)}`;
      const list = byGroupSlot.get(key) ?? [];
      list.push(a);
      byGroupSlot.set(key, list);
    }

    for (const [key, list] of byGroupSlot) {
      if (list.length < 2) continue;
      const classGroupId = key.split("|")[0];
      const group = context.classGroupsById.get(classGroupId);
      conflicts.push(
        makeConflict(
          "H3",
          `Class group "${group?.groupName ?? classGroupId}" has overlapping classes`,
          list.map((a) => a.id),
          { classGroupId }
        )
      );
    }

    // Parallel groups must not share a time slot (bidirectional adjacency)
    const reported = new Set<string>();
    const peersOf = new Map<string, Set<string>>();
    for (const group of context.classGroupsById.values()) {
      for (const peerId of group.parallelGroupIds) {
        if (!peersOf.has(group.id)) peersOf.set(group.id, new Set());
        if (!peersOf.has(peerId)) peersOf.set(peerId, new Set());
        peersOf.get(group.id)!.add(peerId);
        peersOf.get(peerId)!.add(group.id);
      }
    }

    for (const a of context.assignments) {
      const peers = peersOf.get(a.classGroupId);
      if (!peers?.size) continue;
      const group = context.classGroupsById.get(a.classGroupId);
      const aKey = slotKey(a.timeSlot.day, a.timeSlot.period);
      for (const parallelId of peers) {
        const peerAssignments = context.assignments.filter(
          (b) =>
            b.classGroupId === parallelId &&
            slotKey(b.timeSlot.day, b.timeSlot.period) === aKey
        );
        for (const peer of peerAssignments) {
          const pairKey = [a.id, peer.id].sort().join("|");
          if (reported.has(pairKey)) continue;
          reported.add(pairKey);
          conflicts.push(
            makeConflict(
              "H3",
              `Parallel groups "${group?.groupName ?? a.classGroupId}" and "${
                context.classGroupsById.get(parallelId)?.groupName ?? parallelId
              }" overlap`,
              [a.id, peer.id],
              { classGroupId: a.classGroupId }
            )
          );
        }
      }
    }

    return emptyHardResult(conflicts);
  }
}

/** H4 — Room capacity must fit the class group's student count */
export class RoomCapacityRule implements HardConstraintRule {
  readonly code = "H4" as const;
  readonly name = "Room Capacity";
  readonly description = "ขนาดห้องต้องรองรับจำนวนนักเรียน";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];

    for (const a of context.assignments) {
      const room = context.roomsById.get(a.roomId);
      const group = context.classGroupsById.get(a.classGroupId);
      if (!room || !group) continue;

      if (group.studentCount > room.capacity) {
        conflicts.push(
          makeConflict(
            "H4",
            `Room "${room.name}" capacity ${room.capacity} < group "${group.groupName}" size ${group.studentCount}`,
            [a.id],
            { roomId: room.id, classGroupId: group.id }
          )
        );
      }
    }

    return emptyHardResult(conflicts);
  }
}

/**
 * H5 — Subject required room type must match the assigned room
 * (LAB / SPECIFIC courses cannot be placed in THEORY rooms)
 */
export class SpecialRoomRequirementRule implements HardConstraintRule {
  readonly code = "H5" as const;
  readonly name = "Special Room Requirement";
  readonly description = "วิชาปฏิบัติ/แล็บต้องใช้ห้องเฉพาะ";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];

    for (const a of context.assignments) {
      const subject = context.subjectsById.get(a.subjectId);
      const room = context.roomsById.get(a.roomId);
      if (!subject || !room) continue;

      if (subject.requiredRoomType !== room.type) {
        conflicts.push(
          makeConflict(
            "H5",
            `Subject "${subject.name}" requires ${subject.requiredRoomType} but room "${room.name}" is ${room.type}`,
            [a.id],
            { subjectId: subject.id, roomId: room.id }
          )
        );
      }
    }

    return emptyHardResult(conflicts);
  }
}

/**
 * H6 — Teacher must not be scheduled in any `unavailableSlots` entry.
 * Strict hard constraint (0 tolerance).
 */
export class TeacherUnavailableRule implements HardConstraintRule {
  readonly code = "H6" as const;
  readonly name = "Teacher Unavailable Slot";
  readonly description = "ห้ามจัดคาบในช่วงเวลาที่ครูไม่สะดวก";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];

    for (const a of context.assignments) {
      const teacher = context.teachersById.get(a.teacherId);
      if (!teacher) continue;
      const key = slotKey(a.timeSlot.day, a.timeSlot.period);
      if (!(teacher.unavailableSlots as string[]).includes(key)) continue;

      conflicts.push(
        makeConflict(
          "H6",
          `Teacher "${teacher.name}" is unavailable at ${key}`,
          [a.id],
          { teacherId: teacher.id }
        )
      );
    }

    return emptyHardResult(conflicts);
  }
}

/**
 * H7 — Teacher must not exceed `maxHoursPerDay` on any weekday.
 * Strict hard constraint (0 tolerance).
 */
export class TeacherMaxHoursPerDayRule implements HardConstraintRule {
  readonly code = "H7" as const;
  readonly name = "Teacher Max Hours Per Day";
  readonly description = "ห้ามสอนเกินชั่วโมงสูงสุดต่อวัน";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    const byTeacherDay = new Map<string, string[]>();

    for (const a of context.assignments) {
      const key = `${a.teacherId}|${a.timeSlot.day}`;
      const list = byTeacherDay.get(key) ?? [];
      list.push(a.id);
      byTeacherDay.set(key, list);
    }

    for (const [key, ids] of byTeacherDay) {
      const [teacherId, day] = key.split("|");
      const teacher = context.teachersById.get(teacherId!);
      if (!teacher) continue;
      if (ids.length <= teacher.maxHoursPerDay) continue;

      conflicts.push(
        makeConflict(
          "H7",
          `Teacher "${teacher.name}" exceeds maxHoursPerDay (${teacher.maxHoursPerDay}) on ${day} with ${ids.length} periods`,
          ids,
          { teacherId: teacher.id }
        )
      );
    }

    return emptyHardResult(conflicts);
  }
}

/**
 * H8 — Teacher must not exceed `maxHoursPerWeek` across the whole timetable.
 * Strict hard constraint (0 tolerance).
 */
export class TeacherMaxHoursPerWeekRule implements HardConstraintRule {
  readonly code = "H8" as const;
  readonly name = "Teacher Max Hours Per Week";
  readonly description = "ห้ามสอนเกินชั่วโมงสูงสุดต่อสัปดาห์";
  readonly severity = "HARD" as const;

  evaluate(context: ConstraintContext): RuleEvaluationResult {
    const conflicts: ConflictReport[] = [];
    const byTeacher = new Map<string, string[]>();

    for (const a of context.assignments) {
      const list = byTeacher.get(a.teacherId) ?? [];
      list.push(a.id);
      byTeacher.set(a.teacherId, list);
    }

    for (const [teacherId, ids] of byTeacher) {
      const teacher = context.teachersById.get(teacherId);
      if (!teacher) continue;
      if (ids.length <= teacher.maxHoursPerWeek) continue;

      conflicts.push(
        makeConflict(
          "H8",
          `Teacher "${teacher.name}" exceeds maxHoursPerWeek (${teacher.maxHoursPerWeek}) with ${ids.length} periods`,
          ids,
          { teacherId: teacher.id }
        )
      );
    }

    return emptyHardResult(conflicts);
  }
}

export const hardRules: HardConstraintRule[] = [
  new TeacherOverlapRule(),
  new RoomOverlapRule(),
  new ClassGroupOverlapRule(),
  new RoomCapacityRule(),
  new SpecialRoomRequirementRule(),
  new TeacherUnavailableRule(),
  new TeacherMaxHoursPerDayRule(),
  new TeacherMaxHoursPerWeekRule(),
];
