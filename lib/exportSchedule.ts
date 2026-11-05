import type {
  DayOfWeek,
  ScheduleInput,
  ScheduleResult,
  TimeSlot,
} from "../types/schedule";

/** Lazy-loaded xlsx module (browser-only — avoids SSR/chunk crashes) */
type XlsxModule = typeof import("xlsx");

const DAYS: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI"];

export type ExportMeta = {
  institutionName?: string;
  semesterLabel?: string;
};

function assertBrowser(): void {
  if (typeof window === "undefined") {
    throw new Error("Export is only available in the browser");
  }
}

async function loadXlsx(): Promise<XlsxModule> {
  assertBrowser();
  return import("xlsx");
}

function slotKey(day: DayOfWeek, period: number): string {
  return `${day}_P${period}`;
}

function uniquePeriods(timeSlots: TimeSlot[]): number[] {
  return [...new Set(timeSlots.map((s) => s.period))].sort((a, b) => a - b);
}

/** Formal institution / semester header block for every worksheet */
function metaHeaderRows(meta?: ExportMeta): unknown[][] {
  return [
    [
      "Institution / สถานศึกษา",
      meta?.institutionName?.trim() || "—",
    ],
    [
      "Semester / ภาคเรียน-ปีการศึกษา",
      meta?.semesterLabel?.trim() || "—",
    ],
    [],
  ];
}

function cellTextLength(value: unknown): number {
  if (value == null) return 0;
  return String(value)
    .split("\n")
    .reduce((max, line) => Math.max(max, line.length), 0);
}

/** Programmatic column widths so Excel never clips to ### */
function autoFitColumns(aoa: unknown[][]): Array<{ wch: number }> {
  const widths: number[] = [];
  for (const row of aoa) {
    (row as unknown[]).forEach((cell, i) => {
      const len = cellTextLength(cell);
      widths[i] = Math.max(widths[i] ?? 10, len + 2);
    });
  }
  return widths.map((wch) => ({
    wch: Math.min(56, Math.max(10, wch)),
  }));
}

function sheetFromAoA(XLSX: XlsxModule, aoa: unknown[][]) {
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet["!cols"] = autoFitColumns(aoa);
  return sheet;
}

function cellLabel(
  input: ScheduleInput,
  assignmentIds: string[],
  result: ScheduleResult
): string {
  if (!assignmentIds.length) return "";
  const subjectsById = new Map(input.subjects.map((s) => [s.id, s]));
  const teachersById = new Map(input.teachers.map((t) => [t.id, t]));
  const roomsById = new Map(input.rooms.map((r) => [r.id, r]));
  const groupsById = new Map(input.classGroups.map((g) => [g.id, g]));

  return assignmentIds
    .map((id) => result.assignments.find((a) => a.id === id))
    .filter(Boolean)
    .map((a) => {
      const subject = subjectsById.get(a!.subjectId);
      const teacher = teachersById.get(a!.teacherId);
      const room = roomsById.get(a!.roomId);
      const group = groupsById.get(a!.classGroupId);
      return [
        subject?.code ?? a!.subjectId,
        teacher?.name ?? a!.teacherId,
        room?.name ?? a!.roomId,
        group?.groupName ?? a!.classGroupId,
      ].join(" | ");
    })
    .join("\n");
}

function buildMatrixAoA(
  titleEntity: string,
  entityLabel: string,
  match: (a: ScheduleResult["assignments"][number]) => boolean,
  input: ScheduleInput,
  result: ScheduleResult,
  meta?: ExportMeta
): unknown[][] {
  const periods = uniquePeriods(input.timeSlots);
  const rows: unknown[][] = [
    ...metaHeaderRows(meta),
    [`${titleEntity}: ${entityLabel}`],
    ["Period / Time", ...DAYS],
  ];

  for (const period of periods) {
    const slot = input.timeSlots.find((s) => s.period === period);
    const label = slot
      ? `P${period} (${slot.startTime}-${slot.endTime})`
      : `P${period}`;
    const row: unknown[] = [label];

    for (const day of DAYS) {
      const ids = result.assignments
        .filter(
          (a) =>
            match(a) &&
            a.timeSlot.day === day &&
            a.timeSlot.period === period
        )
        .map((a) => a.id);
      row.push(cellLabel(input, ids, result));
    }
    rows.push(row);
  }

  return rows;
}

function appendEntitySections(
  titleEntity: string,
  entities: Array<{ id: string; label: string }>,
  matchFn: (
    entityId: string
  ) => (a: ScheduleResult["assignments"][number]) => boolean,
  input: ScheduleInput,
  result: ScheduleResult,
  meta?: ExportMeta
): unknown[][] {
  const aoa: unknown[][] = [...metaHeaderRows(meta), [`${titleEntity} Schedule`]];

  for (const entity of entities) {
    aoa.push([]);
    const section = buildMatrixAoA(
      titleEntity,
      entity.label,
      matchFn(entity.id),
      input,
      result,
      undefined
    );
    // Drop nested meta when embedding sections — parent sheet already has formal headers
    const withoutMeta = section.slice(3);
    aoa.push(...withoutMeta);
  }

  return aoa;
}

/**
 * Builds a professional multi-sheet workbook:
 * Master Overview · Teachers Schedule · Rooms Utilization · Class Groups
 */
export async function buildScheduleWorkbook(
  result: ScheduleResult,
  input: ScheduleInput,
  meta?: ExportMeta
) {
  const XLSX = await loadXlsx();
  const workbook = XLSX.utils.book_new();
  const subjectsById = new Map(input.subjects.map((s) => [s.id, s]));
  const teachersById = new Map(input.teachers.map((t) => [t.id, t]));
  const roomsById = new Map(input.rooms.map((r) => [r.id, r]));
  const groupsById = new Map(input.classGroups.map((g) => [g.id, g]));

  // —— Master Overview ——
  const masterAoA: unknown[][] = [
    ...metaHeaderRows(meta),
    ["Master Overview — AI Timetable"],
    ["Seed", result.seed],
    ["Execution Time (ms)", result.executionTimeMs],
    ["Room Utilization (%)", Number(result.roomUtilizationPercent.toFixed(2))],
    [
      "Teacher Workload Balance",
      Number(result.teacherWorkloadBalance.toFixed(4)),
    ],
    ["Hard Conflicts", result.hardConflictCount],
    ["Soft Penalty", Number(result.softPenaltyTotal.toFixed(2))],
    [
      "Fitness Score",
      Number.isFinite(result.fitnessScore)
        ? Number(result.fitnessScore.toFixed(2))
        : "n/a",
    ],
    ["Total Assignments", result.assignments.length],
    ["Teachers", input.teachers.length],
    ["Rooms", input.rooms.length],
    ["Class Groups", input.classGroups.length],
    [],
    [
      "Assignment ID",
      "Subject Code",
      "Subject Name",
      "Type",
      "Teacher",
      "Room",
      "Class Group",
      "Day",
      "Period",
      "Slot",
      "Start",
      "End",
    ],
  ];

  const sorted = [...result.assignments].sort((a, b) => {
    const dayOrder = DAYS.indexOf(a.timeSlot.day) - DAYS.indexOf(b.timeSlot.day);
    if (dayOrder !== 0) return dayOrder;
    return a.timeSlot.period - b.timeSlot.period;
  });

  for (const a of sorted) {
    const subject = subjectsById.get(a.subjectId);
    const teacher = teachersById.get(a.teacherId);
    const room = roomsById.get(a.roomId);
    const group = groupsById.get(a.classGroupId);
    masterAoA.push([
      a.id,
      subject?.code ?? a.subjectId,
      subject?.name ?? "",
      subject?.requiredRoomType ?? "",
      teacher?.name ?? a.teacherId,
      room?.name ?? a.roomId,
      group?.groupName ?? a.classGroupId,
      a.timeSlot.day,
      a.timeSlot.period,
      slotKey(a.timeSlot.day, a.timeSlot.period),
      a.timeSlot.startTime,
      a.timeSlot.endTime,
    ]);
  }

  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromAoA(XLSX, masterAoA),
    "Master Overview"
  );

  // —— Teachers Schedule ——
  const teachersAoA = appendEntitySections(
    "Teacher",
    input.teachers.map((t) => ({
      id: t.id,
      label: `${t.name} (${t.id})`,
    })),
    (id) => (a) => a.teacherId === id,
    input,
    result,
    meta
  );
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromAoA(XLSX, teachersAoA),
    "Teachers Schedule"
  );

  // —— Rooms Utilization ——
  const roomsAoA = appendEntitySections(
    "Room",
    input.rooms.map((r) => ({
      id: r.id,
      label: `${r.name} · ${r.type} · cap ${r.capacity} (${r.id})`,
    })),
    (id) => (a) => a.roomId === id,
    input,
    result,
    meta
  );
  // Utilization summary footer
  const periods = uniquePeriods(input.timeSlots);
  const totalSlots = input.rooms.length * periods.length * DAYS.length;
  const used = new Set(
    result.assignments.map(
      (a) => `${a.roomId}|${a.timeSlot.day}|${a.timeSlot.period}`
    )
  ).size;
  roomsAoA.push(
    [],
    ["Utilization Summary"],
    ["Unique room-slots used", used],
    ["Total room-slots available", totalSlots],
    [
      "Utilization %",
      totalSlots
        ? Number(((used / totalSlots) * 100).toFixed(2))
        : 0,
    ]
  );
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromAoA(XLSX, roomsAoA),
    "Rooms Utilization"
  );

  // —— Class Groups ——
  const groupsAoA = appendEntitySections(
    "Class Group",
    input.classGroups.map((g) => ({
      id: g.id,
      label: `${g.groupName} · ${g.department} (${g.id})`,
    })),
    (id) => (a) => a.classGroupId === id,
    input,
    result,
    meta
  );
  XLSX.utils.book_append_sheet(
    workbook,
    sheetFromAoA(XLSX, groupsAoA),
    "Class Groups"
  );

  return { workbook, XLSX };
}

export async function handleExportExcel(
  result: ScheduleResult,
  input: ScheduleInput,
  meta?: ExportMeta,
  filename = `timetable-seed-${result.seed}.xlsx`
): Promise<void> {
  if (typeof window === "undefined") return;
  const { workbook, XLSX } = await buildScheduleWorkbook(result, input, meta);
  XLSX.writeFile(workbook, filename);
}

export function handleExportPdf(): void {
  if (typeof window === "undefined" || typeof window.print !== "function") {
    return;
  }
  window.print();
}
