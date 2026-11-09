/**
 * Smoke test: hard constraints, partial completion, CSP vs Naive benchmark.
 * Run: node scripts/smoke-test.mjs
 */
import { createRequire } from "module";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Use tsx-less transpile via next's compiled? Prefer dynamic import through ts-node/register.
// Fallback: spawn a small TypeScript evaluation via npx tsx if available.

const failures = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
  else console.log("  OK:", msg);
}

async function loadViaTsx() {
  const { execFileSync } = await import("child_process");
  const code = `
const { generateSmallDataset, generateMediumDataset, generateLargeDataset } = require("./lib/mockData.ts");
const { solveSchedule, solveNaiveGreedy, checkHardConstraints, expandLessonDemands } = require("./engine/solver.ts");
const { runAlgorithmComparison } = require("./lib/csp-engine.ts");
const { hardRules } = require("./engine/rules/hardRules.ts");

function summarize(label, result, input) {
  const demands = expandLessonDemands(input).length;
  const hard = checkHardConstraints(input, result.assignments);
  console.log(JSON.stringify({
    label,
    assignments: result.assignments.length,
    demands,
    hardConflictCount: result.hardConflictCount,
    verifiedHard: hard.hardConflictCount,
    completionRate: result.completionRate,
    isPartial: result.isPartial,
    timedOut: !!result.timedOut,
    executionTimeMs: result.executionTimeMs,
    fitnessScore: result.fitnessScore,
  }));
  return { result, hard, demands };
}

const out = {};
for (const [name, gen] of [
  ["small", generateSmallDataset],
  ["medium", generateMediumDataset],
  ["large", generateLargeDataset],
]) {
  const input = gen();
  const csp = solveSchedule(input, 42);
  out[name] = summarize("csp-" + name, csp, input);
}

const mid = generateMediumDataset();
const cmp = runAlgorithmComparison(mid, 42);
console.log(JSON.stringify({ benchmark: cmp }));

// Explicit H6/H7: force unavailable + maxHours and ensure CSP never violates
const input = generateSmallDataset();
if (input.teachers[0]) {
  input.teachers[0].unavailableSlots = input.timeSlots.map(s => s.day + "_P" + s.period);
  input.teachers[0].maxHoursPerDay = 1;
}
const forced = solveSchedule(input, 7);
const forcedCheck = checkHardConstraints(input, forced.assignments);
console.log(JSON.stringify({
  forcedH6H7: {
    assignments: forced.assignments.length,
    hard: forcedCheck.hardConflictCount,
    completionRate: forced.completionRate,
    codes: forcedCheck.conflicts.map(c => c.code),
  }
}));
`;
  const result = execFileSync(
    process.execPath,
    ["--import", "tsx", "-e", code],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TSX_TSCONFIG_PATH: "./tsconfig.json" },
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  return result;
}

console.log("=== Engine smoke test ===");
try {
  const output = await loadViaTsx();
  console.log(output);

  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));

  for (const line of lines) {
    const data = JSON.parse(line);
    if (data.label?.startsWith("csp-")) {
      assert(
        data.verifiedHard === 0,
        `${data.label}: verified hard conflicts == 0 (got ${data.verifiedHard})`
      );
      assert(
        data.hardConflictCount === 0,
        `${data.label}: reported hardConflictCount == 0 (got ${data.hardConflictCount})`
      );
      assert(
        typeof data.completionRate === "number",
        `${data.label}: has completionRate`
      );
      // Must not wipe to empty if there were demands and solver placed something,
      // OR if empty then completion must be 0 (honest).
      if (data.demands > 0 && data.assignments === 0) {
        assert(
          data.completionRate === 0,
          `${data.label}: empty schedule reports 0% completion`
        );
      }
      if (data.assignments > 0 && data.assignments < data.demands) {
        assert(
          data.isPartial === true,
          `${data.label}: partial flagged when incomplete`
        );
      }
    }
    if (data.benchmark) {
      assert(
        data.benchmark.csp.hardConflictCount === 0,
        `benchmark CSP hard == 0 (got ${data.benchmark.csp.hardConflictCount})`
      );
      assert(
        data.benchmark.naive.hardConflictCount >= data.benchmark.csp.hardConflictCount,
        `benchmark naive conflicts >= CSP`
      );
      console.log(
        "  Benchmark CSP vs Naive:",
        `conflicts ${data.benchmark.csp.hardConflictCount} vs ${data.benchmark.naive.hardConflictCount},`,
        `ms ${data.benchmark.csp.executionTimeMs} vs ${data.benchmark.naive.executionTimeMs},`,
        `winner ${data.benchmark.winner}`
      );
    }
    if (data.forcedH6H7) {
      assert(
        data.forcedH6H7.hard === 0,
        `forced H6/H7: hard conflicts == 0 (got ${data.forcedH6H7.hard})`
      );
    }
  }
} catch (err) {
  console.error("Smoke runner failed:", err.message || err);
  process.exitCode = 1;
}

if (failures.length) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(" -", f);
  process.exitCode = 1;
} else {
  console.log("\nAll smoke assertions passed.");
}
