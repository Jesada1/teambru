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
  /** `${teacherId}|${day}` → periods already placed that day (H7) */
  teacherDayHours: Map<string, number>;
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
    teacherDayHours: new Map(),
  };
}

function teacherDayKey(teacherId: string, day: string): string {
  return `${teacherId}|${day}`;
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

/** Bidirectional parallel-group adjacency (fixes one-way mock data links) */
function buildParallelPeers(
  classGroups: ScheduleInput["classGroups"]
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const ensure = (id: string) => {
    let set = map.get(id);
    if (!set) {
      set = new Set();
      map.set(id, set);
    }
    return set;
  };
  for (const group of classGroups) {
    for (const peer of group.parallelGroupIds) {
      ensure(group.id).add(peer);
      ensure(peer).add(group.id);
    }
  }
  return map;
}

function isHardFeasible(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate,
  teacherUnavailable: Map<string, Set<string>>,
  maxHoursByTeacher: Map<string, number>,
  parallelPeers: Map<string, Set<string>>
): boolean {
  const { slotKey, roomId, timeSlot } = candidate;

  if (occupancy.teachers.has(occupancyKey(demand.teacherId, slotKey))) {
    return false; // H1
  }
  if (occupancy.rooms.has(occupancyKey(roomId, slotKey))) {
    return false; // H2
  }
  if (occupancy.groups.has(occupancyKey(demand.classGroupId, slotKey))) {
    return false; // H3
  }
  const peers =
    parallelPeers.get(demand.classGroupId) ??
    new Set(demand.parallelGroupIds);
  for (const parallelId of peers) {
    if (occupancy.groups.has(occupancyKey(parallelId, slotKey))) {
      return false; // H3 parallel (bidirectional)
    }
  }

  // H6 — unavailable slots are strictly forbidden
  const unavailable = teacherUnavailable.get(demand.teacherId);
  if (unavailable?.has(slotKey)) {
    return false;
  }

  // H7 — maxHoursPerDay is strictly enforced during placement
  const dayKey = teacherDayKey(demand.teacherId, timeSlot.day);
  const used = occupancy.teacherDayHours.get(dayKey) ?? 0;
  const maxHours = maxHoursByTeacher.get(demand.teacherId) ?? Number.POSITIVE_INFINITY;
  if (used + 1 > maxHours) {
    return false;
  }

  return true;
}

function place(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate
): void {
  const { slotKey, roomId, timeSlot } = candidate;
  occupancy.teachers.add(occupancyKey(demand.teacherId, slotKey));
  occupancy.rooms.add(occupancyKey(roomId, slotKey));
  occupancy.groups.add(occupancyKey(demand.classGroupId, slotKey));
  const dayKey = teacherDayKey(demand.teacherId, timeSlot.day);
  occupancy.teacherDayHours.set(
    dayKey,
    (occupancy.teacherDayHours.get(dayKey) ?? 0) + 1
  );
}

function unplace(
  occupancy: Occupancy,
  demand: LessonDemand,
  candidate: Candidate
): void {
  const { slotKey, roomId, timeSlot } = candidate;
  occupancy.teachers.delete(occupancyKey(demand.teacherId, slotKey));
  occupancy.rooms.delete(occupancyKey(roomId, slotKey));
  occupancy.groups.delete(occupancyKey(demand.classGroupId, slotKey));
  const dayKey = teacherDayKey(demand.teacherId, timeSlot.day);
  const next = (occupancy.teacherDayHours.get(dayKey) ?? 1) - 1;
  if (next <= 0) occupancy.teacherDayHours.delete(dayKey);
  else occupancy.teacherDayHours.set(dayKey, next);
}

function buildCandidates(
  demand: LessonDemand,
  timeSlots: TimeSlot[],
  rooms: Room[],
  occupancy: Occupancy,
  rand: () => number,
  teacherUnavailable: Map<string, Set<string>>,
  maxHoursByTeacher: Map<string, number>,
  parallelPeers: Map<string, Set<string>>
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
      if (
        isHardFeasible(
          occupancy,
          demand,
          candidate,
          teacherUnavailable,
          maxHoursByTeacher,
          parallelPeers
        )
      ) {
        candidates.push(candidate);
      }
    }
  }

  return shuffleInPlace(candidates, rand);
}

/**
 * Cheap soft heuristic: prefer compact days, same-room adjacency,
 * and capacity headroom. Unavailable / maxHours are hard-filtered already.
 */
function softHeuristicDelta(
  demand: LessonDemand,
  candidate: Candidate,
  partial: ScheduleAssignment[],
  roomsById: Map<string, Room>
): number {
  let score = 0;

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
    } else if (gap > 1) {
      score -= gap * 0.25; // S4 idle gaps
    }
  }

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
  rand: () => number,
  teacherUnavailable: Map<string, Set<string>>,
  maxHoursByTeacher: Map<string, number>,
  parallelPeers: Map<string, Set<string>>
): LessonDemand[] {
  const scored = demands.map((demand) => ({
    demand,
    options: buildCandidates(
      demand,
      timeSlots,
      rooms,
      occupancy,
      () => 0.5,
      teacherUnavailable,
      maxHoursByTeacher,
      parallelPeers
    ).length,
    tie: rand(),
  }));

  scored.sort((a, b) => a.options - b.options || a.tie - b.tie);
  return scored.map((s) => s.demand);
}

function completionOf(assigned: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((assigned / total) * 1000) / 10;
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
  const totalRequiredSlots = expandLessonDemands(input).length;
  const completionRate = completionOf(assignments.length, totalRequiredSlots);

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
    completionRate,
    isPartial: completionRate < 100,
    totalRequiredSlots,
  };
}

/**
 * CSP backtracking solver with seeded heuristics and soft-constraint optimization.
 * Guarantees 0 hard conflicts for returned assignments by only placing via
 * occupancy-checked candidates (H1–H7). On timeout, returns the best feasible
 * partial schedule found so far (never an empty wipe when progress exists).
 */
export function solveSchedule(
  input: ScheduleInput,
  seed = 42
): ScheduleResult {
  const startedAt = Date.now();
  const deadline = startedAt + TIME_LIMIT_MS;
  const rand = mulberry32(seed);

  const teacherUnavailable = new Map(
    input.teachers.map((t) => [t.id, new Set(t.unavailableSlots as string[])])
  );
  const maxHoursByTeacher = new Map(
    input.teachers.map((t) => [t.id, t.maxHoursPerDay])
  );
  const roomsById = new Map(input.rooms.map((r) => [r.id, r]));
  const parallelPeers = buildParallelPeers(input.classGroups);

  let demands = expandLessonDemands(input);
  demands = shuffleInPlace(demands.slice(), rand);
  demands = orderDemandsByMrv(
    demands,
    input.timeSlots,
    input.rooms,
    createOccupancy(),
    rand,
    teacherUnavailable,
    maxHoursByTeacher,
    parallelPeers
  );

  let bestAssignments: ScheduleAssignment[] = [];
  let bestDepth = -1;
  let bestScore = -Infinity;
  let timedOut = false;
  let assignmentSeq = 0;
  let expansions = 0;

  /** Prefer deeper partials; run soft fitness only on complete solutions (perf). */
  const considerPartial = (
    partial: ScheduleAssignment[],
    complete: boolean
  ) => {
    const depth = partial.length;
    const score = complete
      ? softFitness(input, partial).score
      : depth * 1_000_000;
    if (depth > bestDepth || (depth === bestDepth && score > bestScore)) {
      bestDepth = depth;
      bestScore = score;
      bestAssignments = partial.map((a) => ({
        ...a,
        timeSlot: { ...a.timeSlot },
      }));
    }
  };

  const search = (
    index: number,
    partial: ScheduleAssignment[],
    occupancy: Occupancy
  ): void => {
    expansions += 1;
    if (expansions % 64 === 0 && Date.now() >= deadline) {
      timedOut = true;
      considerPartial(partial, false);
      return;
    }

    if (index === demands.length) {
      considerPartial(partial, true);
      return;
    }

    const demand = demands[index]!;
    const candidates = buildCandidates(
      demand,
      input.timeSlots,
      input.rooms,
      occupancy,
      rand,
      teacherUnavailable,
      maxHoursByTeacher,
      parallelPeers
    );

    candidates.sort((a, b) => {
      const sa = softHeuristicDelta(demand, a, partial, roomsById);
      const sb = softHeuristicDelta(demand, b, partial, roomsById);
      return sb - sa;
    });

    if (candidates.length === 0) {
      considerPartial(partial, false);
      return;
    }

    for (const candidate of candidates) {
      if (timedOut) return;
      if (expansions % 64 === 0 && Date.now() >= deadline) {
        timedOut = true;
        considerPartial(partial, false);
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

  const elapsedMs = Date.now() - startedAt;
  const context = buildConstraintContext(input, bestAssignments);
  const hardEval = evaluateRules(hardRules, context);
  // Occupancy search should already be hard-clean; keep only if verified.
  const safeAssignments =
    hardEval.hardConflictCount === 0 ? bestAssignments : [];

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

  const completionRate = completionOf(safeAssignments.length, demands.length);
  const isPartial = completionRate < 100;

  const fitnessScore =
    safeAssignments.length === 0 && demands.length > 0
      ? Number.NEGATIVE_INFINITY
      : -softEval.softPenaltyTotal;

  return {
    assignments: safeAssignments,
    conflicts: softEval.conflicts,
    // Returned schedule is always hard-clean (or empty)
    hardConflictCount: 0,
    softPenaltyTotal: softEval.softPenaltyTotal,
    fitnessScore,
    seed,
    elapsedMs,
    executionTimeMs: elapsedMs,
    roomUtilizationPercent,
    teacherWorkloadBalance,
    completionRate,
    isPartial,
    // Only surface timeout when the returned schedule is still incomplete
    timedOut: timedOut && isPartial,
    totalRequiredSlots: demands.length,
  };
}

/**
 * Naive greedy baseline for competition benchmarks.
 * Only avoids basic double-booking (teacher/room/group) and ignores
 * unavailable slots, maxHoursPerDay, and preferred room types — so it
 * typically accumulates H4–H7 hard conflicts that CSP prevents.
 */
export function solveNaiveGreedy(
  input: ScheduleInput,
  seed = 42
): ScheduleResult {
  const startedAt = Date.now();
  const rand = mulberry32(seed);
  const occupancy = createOccupancy();
  const demands = shuffleInPlace(expandLessonDemands(input).slice(), rand);
  const assignments: ScheduleAssignment[] = [];
  let assignmentSeq = 0;

  for (const demand of demands) {
    let placed = false;
    const slots = shuffleInPlace(input.timeSlots.slice(), rand);
    const rooms = shuffleInPlace(input.rooms.slice(), rand);

    for (const timeSlot of slots) {
      if (placed) break;
      const key = slotKeyOf(timeSlot);
      for (const room of rooms) {
        const candidate: Candidate = {
          timeSlot,
          roomId: room.id,
          slotKey: key,
        };
        // Naive: only H1–H3 occupancy checks
        if (occupancy.teachers.has(occupancyKey(demand.teacherId, key))) continue;
        if (occupancy.rooms.has(occupancyKey(room.id, key))) continue;
        if (occupancy.groups.has(occupancyKey(demand.classGroupId, key))) continue;
        let parallelHit = false;
        for (const parallelId of demand.parallelGroupIds) {
          if (occupancy.groups.has(occupancyKey(parallelId, key))) {
            parallelHit = true;
            break;
          }
        }
        if (parallelHit) continue;

        assignmentSeq += 1;
        const assignment: ScheduleAssignment = {
          id: `N${assignmentSeq}`,
          subjectId: demand.subjectId,
          teacherId: demand.teacherId,
          roomId: room.id,
          classGroupId: demand.classGroupId,
          timeSlot: { ...timeSlot },
        };
        place(occupancy, demand, candidate);
        assignments.push(assignment);
        placed = true;
        break;
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const hard = checkHardConstraints(input, assignments);
  const context = buildConstraintContext(input, assignments);
  const softEval = evaluateRules(softRules, context);
  const totalRequiredSlots = expandLessonDemands(input).length;
  const completionRate = completionOf(assignments.length, totalRequiredSlots);
  const incompletenessPenalty = (totalRequiredSlots - assignments.length) * 10;

  return {
    assignments,
    conflicts: [...hard.conflicts, ...softEval.conflicts],
    hardConflictCount: hard.hardConflictCount,
    softPenaltyTotal: softEval.softPenaltyTotal,
    fitnessScore:
      assignments.length === 0
        ? Number.NEGATIVE_INFINITY
        : -softEval.softPenaltyTotal -
          hard.hardConflictCount * 50 -
          incompletenessPenalty,
    seed,
    elapsedMs,
    executionTimeMs: elapsedMs,
    roomUtilizationPercent: computeRoomUtilizationPercent(
      assignments,
      input.rooms.length,
      input.timeSlots.length
    ),
    teacherWorkloadBalance: computeTeacherWorkloadBalance(
      assignments,
      input.teachers.map((t) => t.id)
    ),
    completionRate,
    isPartial: completionRate < 100,
    totalRequiredSlots,
  };
}
