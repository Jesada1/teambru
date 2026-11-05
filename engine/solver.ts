import type {
  Room,
  RoomType,
  ScheduleAssignment,
  ScheduleInput,
  ScheduleResult,
  TimeSlot,
} from "../types/schedule";
import {
  buildConstraintContext,
  evaluateRules,
  hardRules,
  softRules,
} from "./rules";

const TIME_LIMIT_MS = 3000;

export interface LessonDemand {
  id: string;
  subjectId: string;
  teacherId: string;
  classGroupId: string;
  requiredRoomType: RoomType;
  studentCount: number;
  /** Parallel group ids that must not share this slot (H3) */
  parallelGroupIds: string[];
}

interface Candidate {
  timeSlot: TimeSlot;
  roomId: string;
  slotKey: string;
}

interface Occupancy {
  teachers: Set<string>;
  rooms: Set<string>;
  groups: Set<string>;
}

/** Deterministic PRNG — same seed ⇒ same sequence */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function slotKeyOf(slot: TimeSlot): string {
  return `${slot.day}_P${slot.period}`;
}

function occupancyKey(entityId: string, slotKey: string): string {
  return `${entityId}|${slotKey}`;
}

function shuffleInPlace<T>(items: T[], rand: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function createOccupancy(): Occupancy {
  return {
    teachers: new Set(),
    rooms: new Set(),
    groups: new Set(),
  };
}

/** Expand each subject into `periodsPerWeek` lesson demands */
export function expandLessonDemands(input: ScheduleInput): LessonDemand[] {
  const groupsById = new Map(input.classGroups.map((g) => [g.id, g]));
  const demands: LessonDemand[] = [];

  for (const subject of input.subjects) {
    const group = groupsById.get(subject.classGroupId);
    const studentCount = group?.studentCount ?? 0;
    const parallelGroupIds = group?.parallelGroupIds ?? [];

    for (let i = 0; i < subject.periodsPerWeek; i++) {
      demands.push({
        id: `${subject.id}#${i + 1}`,
        subjectId: subject.id,
        teacherId: subject.assignedTeacherId,
        classGroupId: subject.classGroupId,
        requiredRoomType: subject.requiredRoomType,
        studentCount,
        parallelGroupIds,
      });
    }
  }

  return demands;
}

/** H4 + H5 room pre-filter */
export function filterCandidateRooms(
  rooms: Room[],
  requiredRoomType: RoomType,
  studentCount: number
): Room[] {
  return rooms.filter(
    (room) =>
      room.type === requiredRoomType && room.capacity >= studentCount
  );
}

function isHardFeasible(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate
): boolean {
  const { slotKey, roomId } = candidate;

  if (occupancy.teachers.has(occupancyKey(demand.teacherId, slotKey))) {
    return false; // H1
  }
  if (occupancy.rooms.has(occupancyKey(roomId, slotKey))) {
    return false; // H2
  }
  if (occupancy.groups.has(occupancyKey(demand.classGroupId, slotKey))) {
    return false; // H3
  }
  for (const parallelId of demand.parallelGroupIds) {
    if (occupancy.groups.has(occupancyKey(parallelId, slotKey))) {
      return false; // H3 parallel
    }
  }
  return true;
}

function place(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate
): void {
  const { slotKey, roomId } = candidate;
  occupancy.teachers.add(occupancyKey(demand.teacherId, slotKey));
  occupancy.rooms.add(occupancyKey(roomId, slotKey));
  occupancy.groups.add(occupancyKey(demand.classGroupId, slotKey));
}

function unplace(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate
): void {
  const { slotKey, roomId } = candidate;
  occupancy.teachers.delete(occupancyKey(demand.teacherId, slotKey));
  occupancy.rooms.delete(occupancyKey(roomId, slotKey));
  occupancy.groups.delete(occupancyKey(demand.classGroupId, slotKey));
}

function buildCandidates(
  demand: LessonDemand,
  timeSlots: TimeSlot[],
  rooms: Room[],
  occupancy: Occupancy,
  rand: () => number
): Candidate[] {
  const eligibleRooms = filterCandidateRooms(
    rooms,
    demand.requiredRoomType,
    demand.studentCount
  );
  const candidates: Candidate[] = [];

  for (const timeSlot of timeSlots) {
    const key = slotKeyOf(timeSlot);
    for (const room of eligibleRooms) {
      const candidate: Candidate = {
        timeSlot,
        roomId: room.id,
        slotKey: key,
      };
      if (isHardFeasible(occupancy, demand, candidate)) {
        candidates.push(candidate);
      }
    }
  }

  return shuffleInPlace(candidates, rand);
}

/**
 * Cheap soft heuristic: prefer avoiding unavailable slots, room churn,
 * and very long consecutive runs for the class group.
 */
function softHeuristicDelta(
  demand: LessonDemand,
  candidate: Candidate,
  partial: ScheduleAssignment[],
  teacherUnavailable: Map<string, Set<string>>,
  roomsById: Map<string, Room>
): number {
  let score = 0;
  const unavailable = teacherUnavailable.get(demand.teacherId);
  if (unavailable?.has(candidate.slotKey)) {
    score -= 3; // S4
  }

  const sameDay = partial.filter(
    (a) =>
      a.classGroupId === demand.classGroupId &&
      a.timeSlot.day === candidate.timeSlot.day
  );

  if (sameDay.length > 0) {
    const prev = sameDay.reduce((best, a) =>
      Math.abs(a.timeSlot.period - candidate.timeSlot.period) <
      Math.abs(best.timeSlot.period - candidate.timeSlot.period)
        ? a
        : best
    );
    const gap = Math.abs(prev.timeSlot.period - candidate.timeSlot.period);
    if (gap === 1) {
      if (prev.roomId === candidate.roomId) score += 1.5; // S2
      else score -= 1.5;

      const consecutiveCount =
        sameDay.filter(
          (a) =>
            Math.abs(a.timeSlot.period - candidate.timeSlot.period) <= 2
        ).length + 1;
      if (consecutiveCount > 3) score -= 2; // S1 pressure
    }
  }

  // Slight preference for larger leftover capacity headroom (S3-ish balance proxy)
  const room = roomsById.get(candidate.roomId);
  if (room) {
    score += Math.min(1, (room.capacity - demand.studentCount) / 40);
  }

  return score;
}

function orderDemandsByMrv(
  demands: LessonDemand[],
  timeSlots: TimeSlot[],
  rooms: Room[],
  occupancy: Occupancy,
  rand: () => number
): LessonDemand[] {
  const scored = demands.map((demand) => ({
    demand,
    options: buildCandidates(demand, timeSlots, rooms, occupancy, () => 0.5)
      .length,
    tie: rand(),
  }));

  scored.sort((a, b) => a.options - b.options || a.tie - b.tie);
  return scored.map((s) => s.demand);
}

function stdev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function computeRoomUtilizationPercent(
  assignments: ScheduleAssignment[],
  roomCount: number,
  slotCount: number
): number {
  const total = roomCount * slotCount;
  if (total === 0) return 0;
  const used = new Set(
    assignments.map((a) => `${a.roomId}|${slotKeyOf(a.timeSlot)}`)
  );
  return (used.size / total) * 100;
}

function computeTeacherWorkloadBalance(
  assignments: ScheduleAssignment[],
  teacherIds: string[]
): number {
  if (teacherIds.length === 0) return 1;

  const hours = teacherIds.map(
    (id) => assignments.filter((a) => a.teacherId === id).length
  );
  const mean = hours.reduce((s, h) => s + h, 0) / hours.length;
  if (mean === 0) return 1;

  const balance = 1 - stdev(hours) / mean;
  return Math.min(1, Math.max(0, balance));
}

function softFitness(
  input: ScheduleInput,
  assignments: ScheduleAssignment[]
): { score: number; softPenaltyTotal: number } {
  const context = buildConstraintContext(input, assignments);
  const { softPenaltyTotal } = evaluateRules(softRules, context);
  return {
    softPenaltyTotal,
    score: -softPenaltyTotal,
  };
}

/** Lightweight hard-constraint check for manual edits / slot swaps */
export function checkHardConstraints(
  input: ScheduleInput,
  assignments: ScheduleAssignment[]
): {
  ok: boolean;
  conflicts: ReturnType<typeof evaluateRules>["conflicts"];
  hardConflictCount: number;
} {
  const context = buildConstraintContext(input, assignments);
  const { conflicts, hardConflictCount } = evaluateRules(hardRules, context);
  return {
    ok: hardConflictCount === 0,
    conflicts,
    hardConflictCount,
  };
}

/** Recompute KPIs after a manual schedule mutation */
export function recomputeScheduleMetrics(
  input: ScheduleInput,
  assignments: ScheduleAssignment[],
  seed: number,
  elapsedMs = 0
): ScheduleResult {
  const hard = checkHardConstraints(input, assignments);
  const context = buildConstraintContext(input, assignments);
  const softEval = evaluateRules(softRules, context);
  const roomUtilizationPercent = computeRoomUtilizationPercent(
    assignments,
    input.rooms.length,
    input.timeSlots.length
  );
  const teacherWorkloadBalance = computeTeacherWorkloadBalance(
    assignments,
    input.teachers.map((t) => t.id)
  );

  return {
    assignments,
    conflicts: softEval.conflicts,
    hardConflictCount: hard.hardConflictCount,
    softPenaltyTotal: softEval.softPenaltyTotal,
    fitnessScore:
      assignments.length === 0
        ? Number.NEGATIVE_INFINITY
        : -softEval.softPenaltyTotal,
    seed,
    elapsedMs,
    executionTimeMs: elapsedMs,
    roomUtilizationPercent,
    teacherWorkloadBalance,
  };
}

/**
 * CSP backtracking solver with seeded heuristics and soft-constraint optimization.
 * Guarantees 0 hard conflicts for any returned complete (or empty) assignment set
 * by only placing via occupancy-checked candidates (H1–H5).
 */
export function solveSchedule(
  input: ScheduleInput,
  seed = 42
): ScheduleResult {
  const startedAt = Date.now();
  const deadline = startedAt + TIME_LIMIT_MS;
  const rand = mulberry32(seed);

  const teacherUnavailable = new Map(
    input.teachers.map((t) => [t.id, new Set(t.unavailableSlots)])
  );
  const roomsById = new Map(input.rooms.map((r) => [r.id, r]));

  let demands = expandLessonDemands(input);
  demands = shuffleInPlace(demands.slice(), rand);
  demands = orderDemandsByMrv(
    demands,
    input.timeSlots,
    input.rooms,
    createOccupancy(),
    rand
  );

  let bestAssignments: ScheduleAssignment[] = [];
  let bestScore = -Infinity;
  let timedOut = false;
  let assignmentSeq = 0;

  const search = (
    index: number,
    partial: ScheduleAssignment[],
    occupancy: Occupancy
  ): void => {
    if (Date.now() >= deadline) {
      timedOut = true;
      return;
    }

    if (index === demands.length) {
      const { score } = softFitness(input, partial);
      if (score > bestScore) {
        bestScore = score;
        bestAssignments = partial.slice();
      }
      return;
    }

    // Keep improving under remaining budget even after first complete solution
    const demand = demands[index];
    let candidates = buildCandidates(
      demand,
      input.timeSlots,
      input.rooms,
      occupancy,
      rand
    );

    candidates.sort((a, b) => {
      const sa = softHeuristicDelta(
        demand,
        a,
        partial,
        teacherUnavailable,
        roomsById
      );
      const sb = softHeuristicDelta(
        demand,
        b,
        partial,
        teacherUnavailable,
        roomsById
      );
      return sb - sa;
    });

    for (const candidate of candidates) {
      if (timedOut || Date.now() >= deadline) {
        timedOut = true;
        return;
      }

      assignmentSeq += 1;
      const assignment: ScheduleAssignment = {
        id: `A${assignmentSeq}`,
        subjectId: demand.subjectId,
        teacherId: demand.teacherId,
        roomId: candidate.roomId,
        classGroupId: demand.classGroupId,
        timeSlot: { ...candidate.timeSlot },
      };

      place(occupancy, demand, candidate);
      partial.push(assignment);

      search(index + 1, partial, occupancy);

      partial.pop();
      unplace(occupancy, demand, candidate);

      if (timedOut) return;
    }
  };

  search(0, [], createOccupancy());

  // If no complete solution within budget, return empty feasible schedule
  // (never a partial with incomplete demands that could mislead callers).
  const assignments = bestAssignments;

  const elapsedMs = Date.now() - startedAt;
  const context = buildConstraintContext(input, assignments);

  // Safety net: occupancy + room filters already enforce H1–H5
  const hardEval = evaluateRules(hardRules, context);
  const safeAssignments =
    hardEval.hardConflictCount === 0 ? assignments : [];

  const finalContext = buildConstraintContext(input, safeAssignments);
  const softEval = evaluateRules(softRules, finalContext);

  const roomUtilizationPercent = computeRoomUtilizationPercent(
    safeAssignments,
    input.rooms.length,
    input.timeSlots.length
  );
  const teacherWorkloadBalance = computeTeacherWorkloadBalance(
    safeAssignments,
    input.teachers.map((t) => t.id)
  );

  const fitnessScore =
    safeAssignments.length === 0 && demands.length > 0
      ? Number.NEGATIVE_INFINITY
      : -softEval.softPenaltyTotal;

  return {
    assignments: safeAssignments,
    conflicts: softEval.conflicts,
    hardConflictCount: 0,
    softPenaltyTotal: softEval.softPenaltyTotal,
    fitnessScore,
    seed,
    elapsedMs,
    executionTimeMs: elapsedMs,
    roomUtilizationPercent,
    teacherWorkloadBalance,
  };
}
