import { generateMediumDataset } from "../lib/mockData";
import { solveSchedule } from "../engine/solver";

const input = generateMediumDataset();
const result = solveSchedule(input, 42);

const base = process.env.BASE_URL || "http://localhost:3000";

async function main() {
  console.log("POST /api/schedule/agent …");
  const res = await fetch(`${base}/api/schedule/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: `ครู ${input.teachers[0]?.name ?? "T001"} ลากิจคาบ 1`,
      input,
      result,
    }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    status?: string;
    pipeline?: { steps?: Array<{ stage: string; status: string }> };
    hardConflictCount?: number;
    error?: string;
    code?: string;
  };
  console.log("status", res.status, {
    ok: data.ok,
    status: data.status,
    hardConflictCount: data.hardConflictCount,
    code: data.code,
    error: data.error,
    pipeline: data.pipeline?.steps?.map((s) => `${s.stage}:${s.status}`),
  });

  if (!data.pipeline?.steps || data.pipeline.steps.length < 2) {
    console.error("FAIL: missing Plan-Act-Check pipeline");
    process.exit(1);
  }
  const stages = data.pipeline.steps.map((s) => s.stage);
  if (!stages.includes("PLAN") || !stages.includes("ACT") || !stages.includes("CHECK")) {
    console.error("FAIL: pipeline stages incomplete", stages);
    process.exit(1);
  }
  console.log("API smoke OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
