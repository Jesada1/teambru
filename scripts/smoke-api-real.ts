import { generateMediumDataset } from "../lib/mockData";
import { solveSchedule } from "../engine/solver";

async function main() {
  const input = generateMediumDataset();
  const result = solveSchedule(input, 42);
  const a = result.assignments[0];
  if (!a) {
    console.error("No assignments from CSP");
    process.exit(1);
  }
  const teacher = input.teachers.find((t) => t.id === a.teacherId)!;
  const dayTh: Record<string, string> = {
    MON: "จันทร์",
    TUE: "อังคาร",
    WED: "พุธ",
    THU: "พฤหัส",
    FRI: "ศุกร์",
  };
  const prompt = `${teacher.name} ลากิจคาบ ${a.timeSlot.period} วัน${dayTh[a.timeSlot.day]}`;
  console.log("prompt:", prompt);

  const res = await fetch("http://localhost:3000/api/schedule/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, input, result }),
  });
  const data = (await res.json()) as {
    ok?: boolean;
    status?: string;
    message?: string;
    error?: string;
    hardConflictCount?: number;
    result?: { hardConflictCount: number; assignments: unknown[] };
    pipeline?: { steps: Array<{ stage: string; status: string }> };
  };

  console.log({
    http: res.status,
    ok: data.ok,
    status: data.status,
    hard: data.hardConflictCount ?? data.result?.hardConflictCount,
    pipeline: data.pipeline?.steps.map((s) => `${s.stage}:${s.status}`),
    message: data.message || data.error,
  });

  if (!data.pipeline?.steps.some((s) => s.stage === "PLAN")) {
    process.exit(1);
  }
  console.log("API real-slot smoke OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
