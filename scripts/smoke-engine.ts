import {
  generateLargeDataset,
  generateMediumDataset,
  generateSmallDataset,
} from "../lib/mockData";
import { runAlgorithmComparison } from "../lib/csp-engine";
import {
  checkHardConstraints,
  expandLessonDemands,
  solveNaiveGreedy,
  solveSchedule,
} from "../engine/solver";
import type { ScheduleInput, ScheduleResult } from "../types/schedule";

const failures: string[] = [];

function assert(cond: boolean, msg: string) {
  if (!cond) {
    failures.push(msg);
    console.log("  FAIL:", msg);
  } else {
    console.log("  OK:", msg);
  }
}

function report(label: string, result: ScheduleResult, input: ScheduleInput) {
  const demands = expandLessonDemands(input).length;
  const hard = checkHardConstraints(input, result.assignments);
  console.log(`\n[${label}]`, {
    assignments: result.assignments.length,
    demands,
    hardConflictCount: result.hardConflictCount,
    verifiedHard: hard.hardConflictCount,
    completionRate: result.completionRate,
    isPartial: result.isPartial,
    timedOut: !!result.timedOut,
    executionTimeMs: result.executionTimeMs,
  });

  assert(
    hard.hardConflictCount === 0,
    `${label}: verified hard conflicts == 0 (got ${hard.hardConflictCount})`
  );
  assert(
    result.hardConflictCount === 0 || result.assignments.length === 0,
    `${label}: reported hardConflictCount consistent`
  );
  assert(
    typeof result.completionRate === "number",
    `${label}: has completionRate`
  );

  if (result.assignments.length > 0 && result.assignments.length < demands) {
    assert(result.isPartial === true, `${label}: isPartial when incomplete`);
    assert(
      result.completionRate < 100,
      `${label}: completionRate < 100 when incomplete`
    );
  }
  if (result.assignments.length === demands && demands > 0) {
    assert(
      result.completionRate === 100,
      `${label}: completionRate 100 when complete`
    );
  }

  // H6/H7 spot-check on assignments
  for (const a of result.assignments) {
    const teacher = input.teachers.find((t) => t.id === a.teacherId);
    if (!teacher) continue;
    const key = `${a.timeSlot.day}_P${a.timeSlot.period}`;
    assert(
      !(teacher.unavailableSlots as string[]).includes(key),
      `${label}: no H6 violation on ${a.id}`
    );
  }
  const byTeacherDay = new Map<string, number>();
  for (const a of result.assignments) {
    const k = `${a.teacherId}|${a.timeSlot.day}`;
    byTeacherDay.set(k, (byTeacherDay.get(k) ?? 0) + 1);
  }
  for (const [k, count] of byTeacherDay) {
    const teacherId = k.split("|")[0]!;
    const teacher = input.teachers.find((t) => t.id === teacherId);
    if (!teacher) continue;
    assert(
      count <= teacher.maxHoursPerDay,
      `${label}: no H7 violation ${k} ${count}/${teacher.maxHoursPerDay}`
    );
  }

  return result;
}

console.log("=== Engine correctness smoke ===");

for (const [name, gen] of [
  ["small", generateSmallDataset],
  ["medium", generateMediumDataset],
  ["large", generateLargeDataset],
] as const) {
  report(`csp-${name}`, solveSchedule(gen(), 42), gen());
}

const mid = generateMediumDataset();
const cmp = runAlgorithmComparison(mid, 42);
console.log("\n[benchmark]", {
  csp: {
    hard: cmp.csp.hardConflictCount,
    ms: cmp.csp.executionTimeMs,
    fitness: cmp.csp.fitnessScore,
    completion: cmp.csp.completionRate,
  },
  naive: {
    hard: cmp.naive.hardConflictCount,
    ms: cmp.naive.executionTimeMs,
    fitness: cmp.naive.fitnessScore,
    completion: cmp.naive.completionRate,
  },
  winner: cmp.winner,
});
assert(cmp.csp.hardConflictCount === 0, "benchmark CSP hard == 0");
assert(
  cmp.naive.hardConflictCount >= cmp.csp.hardConflictCount,
  "benchmark naive hard >= CSP hard"
);

// Forced unavailable + tiny maxHours — CSP must stay hard-clean
const forced = generateSmallDataset();
forced.teachers = forced.teachers.map((t, i) =>
  i === 0
    ? {
        ...t,
        maxHoursPerDay: 1,
        unavailableSlots: forced.timeSlots.map(
          (s) => `${s.day}_P${s.period}` as `${typeof s.day}_P${number}`
        ),
      }
    : t
);
const forcedResult = solveSchedule(forced, 7);
const forcedHard = checkHardConstraints(forced, forcedResult.assignments);
console.log("\n[forced-H6-H7]", {
  assignments: forcedResult.assignments.length,
  hard: forcedHard.hardConflictCount,
  completionRate: forcedResult.completionRate,
});
assert(forcedHard.hardConflictCount === 0, "forced H6/H7 stays hard-clean");

// Naive should often produce conflicts on medium (room type / capacity / unavailable)
const naive = solveNaiveGreedy(generateMediumDataset(), 42);
console.log("\n[naive-medium]", {
  hard: naive.hardConflictCount,
  completion: naive.completionRate,
  ms: naive.executionTimeMs,
});

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nAll engine smoke assertions passed.");
