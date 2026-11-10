/**
 * Smoke test for the Thanyalak competition scenario (H9–H11).
 * Run: npx tsx scripts/smoke-thanyalak.ts
 */
import { solveSchedule } from "../engine/solver";
import { generateThanyalakScenario } from "../lib/mockData";

function slotKey(day: string, period: number): string {
  return `${day}_P${period}`;
}

const input = generateThanyalakScenario();
const result = solveSchedule(input, 42);

const subjectsById = new Map(input.subjects.map((s) => [s.id, s]));
const roomsById = new Map(input.rooms.map((r) => [r.id, r]));

const g11Slots = result.assignments
  .filter((a) => a.classGroupId === "G11")
  .map((a) => slotKey(a.timeSlot.day, a.timeSlot.period));

const g11TueMorning = g11Slots.filter((s) =>
  ["TUE_P1", "TUE_P2", "TUE_P3"].includes(s)
);

const theoryWedPm = result.assignments.filter((a) => {
  const room = roomsById.get(a.roomId);
  if (!room || room.type !== "THEORY") return false;
  return ["WED_P5", "WED_P6", "WED_P7", "WED_P8"].includes(
    slotKey(a.timeSlot.day, a.timeSlot.period)
  );
});

const fri78 = result.assignments.filter((a) =>
  ["FRI_P7", "FRI_P8"].includes(slotKey(a.timeSlot.day, a.timeSlot.period))
);
const fri78NonActivity = fri78.filter((a) => a.subjectId !== "S_ACTIVITY");
const activitySlots = result.assignments
  .filter((a) => a.subjectId === "S_ACTIVITY")
  .map((a) => slotKey(a.timeSlot.day, a.timeSlot.period))
  .sort();

console.log(
  JSON.stringify(
    {
      hardConflictCount: result.hardConflictCount,
      completionRate: result.completionRate,
      isPartial: result.isPartial,
      timedOut: result.timedOut,
      executionTimeMs: result.executionTimeMs,
      assignmentCount: result.assignments.length,
      checks: {
        g11AvoidsTueMorning: g11TueMorning.length === 0,
        theoryAvoidsWedAfternoon: theoryWedPm.length === 0,
        fri78OnlyActivity: fri78NonActivity.length === 0,
        activityOnFri78: activitySlots.join("|"),
      },
      sample: result.assignments.slice(0, 5).map((a) => ({
        subject: subjectsById.get(a.subjectId)?.code,
        group: a.classGroupId,
        room: roomsById.get(a.roomId)?.name,
        slot: slotKey(a.timeSlot.day, a.timeSlot.period),
      })),
    },
    null,
    2
  )
);

const ok =
  result.hardConflictCount === 0 &&
  g11TueMorning.length === 0 &&
  theoryWedPm.length === 0 &&
  fri78NonActivity.length === 0;

if (!ok) {
  console.error("SMOKE FAILED");
  process.exit(1);
}

console.log("SMOKE OK");
