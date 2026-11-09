import { generateSmallDataset } from "../lib/mockData";
import {
  expandLessonDemands,
  solveSchedule,
} from "../engine/solver";
import {
  buildConstraintContext,
  evaluateRules,
  hardRules,
} from "../engine/rules";

const input = generateSmallDataset();
console.log("meta", {
  teachers: input.teachers.length,
  subjects: input.subjects.length,
  rooms: input.rooms.length,
  groups: input.classGroups.length,
  slots: input.timeSlots.length,
  demands: expandLessonDemands(input).length,
});
console.log("teacher0", input.teachers[0]);
console.log("subject0", input.subjects[0]);

const t0 = Date.now();
const result = solveSchedule(input, 42);
console.log("elapsed wall", Date.now() - t0);
console.log("result", {
  n: result.assignments.length,
  hard: result.hardConflictCount,
  soft: result.softPenaltyTotal,
  completion: result.completionRate,
  isPartial: result.isPartial,
  timedOut: result.timedOut,
  ms: result.executionTimeMs,
  fitness: result.fitnessScore,
});

// Manually inspect if we can get a non-empty by increasing patience — check feasibility density
const demands = expandLessonDemands(input);
let infeasible = 0;
for (const d of demands) {
  const rooms = input.rooms.filter(
    (r) => r.type === d.requiredRoomType && r.capacity >= d.studentCount
  );
  if (rooms.length === 0) infeasible += 1;
}
console.log("demands with zero eligible rooms", infeasible);

// Simulate: what conflicts would exist if we take naive greedy under hard filters?
import { solveNaiveGreedy } from "../engine/solver";
const naive = solveNaiveGreedy(input, 42);
const ctx = buildConstraintContext(input, naive.assignments);
const hard = evaluateRules(hardRules, ctx);
console.log("naive", {
  n: naive.assignments.length,
  hard: hard.hardConflictCount,
  codes: hard.conflicts.map((c) => c.code),
  sample: hard.conflicts.slice(0, 5).map((c) => c.message),
});
