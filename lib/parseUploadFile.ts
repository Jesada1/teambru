import type { ScheduleInput, Teacher, TimeSlot } from "../types/schedule";

type XlsxModule = typeof import("xlsx");

async function loadXlsx(): Promise<XlsxModule> {
  if (typeof window === "undefined") {
    throw new Error("Excel parsing is only available in the browser");
  }
  return import("xlsx");
}
import {
  DATASET_ROW_TARGETS,
  generateDefaultTimeSlots,
  generateMockDataset,
  type DatasetSize,
} from "./mockData";
import type { UploadEntityKind } from "./validations/autoFix";
import {
  classGroupRowSchema,
  roomRowSchema,
  subjectRowSchema,
  teacherRowSchema,
  timeSlotRowSchema,
  timeSlotUniqueKey,
  validateEntityRows,
  type RowValidationIssue,
  type TimeSlotRow,
} from "./validations/upload";

export type PreviewRow = {
  key: string;
  rowIndex: number;
  entity: UploadEntityKind;
  raw: Record<string, unknown>;
  values: Record<string, string>;
  issues: RowValidationIssue[];
};

export type ParsedUploadState = {
  teachers: Record<string, unknown>[];
  subjects: Record<string, unknown>[];
  rooms: Record<string, unknown>[];
  classGroups: Record<string, unknown>[];
  timeSlots: Record<string, unknown>[];
  previewRows: PreviewRow[];
  errorRowCount: number;
  totalRowCount: number;
};

const ENTITY_HEADERS: Record<UploadEntityKind, string[]> = {
  teacher: ["id", "name", "maxHoursPerDay", "maxHoursPerWeek", "unavailableSlots"],
  subject: [
    "id",
    "code",
    "name",
    "periodsPerWeek",
    "requiredRoomType",
    "assignedTeacherId",
    "classGroupId",
    "lockedSlots",
  ],
  room: ["id", "name", "type", "capacity", "unavailableSlots"],
  classGroup: [
    "id",
    "groupName",
    "studentCount",
    "department",
    "parallelGroupIds",
    "unavailableSlots",
  ],
  timeSlot: ["day", "period", "startTime", "endTime"],
};

function detectEntity(row: Record<string, unknown>): UploadEntityKind | null {
  const explicit = String(row.entity ?? row.Entity ?? row.type_entity ?? "")
    .trim()
    .toLowerCase();

  if (explicit === "teacher" || explicit === "teachers") return "teacher";
  if (explicit === "subject" || explicit === "subjects" || explicit === "course")
    return "subject";
  if (explicit === "room" || explicit === "rooms") return "room";
  if (
    explicit === "classgroup" ||
    explicit === "class_group" ||
    explicit === "classgroups" ||
    explicit === "group"
  ) {
    return "classGroup";
  }
  if (explicit === "timeslot" || explicit === "time_slot" || explicit === "timeslots")
    return "timeSlot";

  if (row.assignedTeacherId != null || row.requiredRoomType != null) return "subject";
  if (row.groupName != null || row.studentCount != null) return "classGroup";
  if (row.capacity != null && row.type != null) return "room";
  if (row.maxHoursPerWeek != null || row.unavailableSlots != null) return "teacher";
  if (row.day != null && row.period != null) return "timeSlot";
  return null;
}

/** Minimal RFC4180-ish CSV parser */
export function parseCsv(text: string): Record<string, unknown>[] {
  const rows: string[][] = [];
  let cell = "";
  let row: string[] = [];
  let inQuotes = false;

  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      pushCell();
    } else if (ch === "\n") {
      pushCell();
      pushRow();
    } else if (ch === "\r") {
      // ignore CR (handle CRLF via \n)
    } else {
      cell += ch;
    }
  }
  pushCell();
  pushRow();

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      obj[header] = cols[idx] ?? "";
    });
    return obj;
  });
}

/** Normalize sheet title → entity kind (case-insensitive) */
const SHEET_NAME_ALIASES: Array<{ match: RegExp; entity: UploadEntityKind }> = [
  { match: /^teachers?$/i, entity: "teacher" },
  { match: /^subjects?$|^courses?$/i, entity: "subject" },
  { match: /^rooms?$/i, entity: "room" },
  { match: /^class[\s_-]?groups?$|^groups?$/i, entity: "classGroup" },
  { match: /^time[\s_-]?slots?$/i, entity: "timeSlot" },
];

function entityFromSheetName(sheetName: string): UploadEntityKind | null {
  const name = sheetName.trim();
  for (const alias of SHEET_NAME_ALIASES) {
    if (alias.match.test(name)) return alias.entity;
  }
  // Soft fallback for partial names
  const lower = name.toLowerCase();
  if (lower.includes("teacher")) return "teacher";
  if (lower.includes("subject") || lower.includes("course")) return "subject";
  if (lower.includes("room")) return "room";
  if (lower.includes("class") || lower.includes("group")) return "classGroup";
  if (lower.includes("time")) return "timeSlot";
  return null;
}

function sheetHasEntityColumn(rows: Record<string, unknown>[]): boolean {
  return rows.some(
    (row) =>
      row.entity != null ||
      row.Entity != null ||
      Object.keys(row).some((k) => k.toLowerCase() === "entity")
  );
}

function normalizeSheetRows(
  rows: Record<string, unknown>[]
): Record<string, unknown>[] {
  return rows
    .map((row) => {
      const next: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) continue;
        next[trimmedKey] =
          typeof value === "string" ? value.trim() : value ?? "";
      }
      return next;
    })
    .filter((row) =>
      Object.values(row).some((v) => String(v ?? "").trim() !== "")
    );
}

function tagRowsWithEntity(
  rows: Record<string, unknown>[],
  entity: UploadEntityKind
): Record<string, unknown>[] {
  return rows.map((row) => ({ ...row, entity }));
}

/**
 * Excel (.xlsx / .xls) parser via SheetJS:
 * - Multi-sheet mode: sheets named Teachers / Subjects / Rooms / ClassGroups / TimeSlots
 * - Single-sheet (or entity-column) mode: same flat CSV shape with an `entity` column
 */
export async function parseExcel(
  buffer: ArrayBuffer
): Promise<Record<string, unknown>[]> {
  const XLSX = await loadXlsx();
  const workbook = XLSX.read(buffer, { type: "array" });
  if (!workbook.SheetNames.length) {
    throw new Error("Excel workbook has no sheets.");
  }

  const sheetPayloads = workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });
    return {
      sheetName,
      rows: normalizeSheetRows(raw),
      entity: entityFromSheetName(sheetName),
    };
  }).filter((s) => s.rows.length > 0);

  if (!sheetPayloads.length) {
    throw new Error("Excel workbook contains no data rows.");
  }

  const namedEntitySheets = sheetPayloads.filter((s) => s.entity != null);
  const useMultiSheet =
    workbook.SheetNames.length > 1 && namedEntitySheets.length >= 2;

  // —— Multi-Sheet Mode (recommended) ——
  if (useMultiSheet) {
    const rows: Record<string, unknown>[] = [];
    for (const sheet of namedEntitySheets) {
      rows.push(
        ...tagRowsWithEntity(sheet.rows, sheet.entity as UploadEntityKind)
      );
    }
    // Include leftover sheets that have an entity column
    for (const sheet of sheetPayloads) {
      if (sheet.entity) continue;
      if (!sheetHasEntityColumn(sheet.rows)) continue;
      rows.push(...sheet.rows);
    }
    return rows;
  }

  // —— Single Sheet / entity-column Mode ——
  const rows: Record<string, unknown>[] = [];
  for (const sheet of sheetPayloads) {
    if (sheetHasEntityColumn(sheet.rows)) {
      rows.push(...sheet.rows);
      continue;
    }
    if (sheet.entity) {
      rows.push(...tagRowsWithEntity(sheet.rows, sheet.entity));
      continue;
    }
    // Last resort: try per-row detection later via buildParsedUploadState
    rows.push(...sheet.rows);
  }

  return rows;
}

export async function parseUploadFile(
  file: File
): Promise<Record<string, unknown>[]> {
  const name = file.name.toLowerCase();
  const mime = file.type;

  if (
    name.endsWith(".csv") ||
    name.endsWith(".txt") ||
    mime === "text/csv" ||
    mime === "text/plain"
  ) {
    const text = await file.text();
    return parseCsv(text);
  }

  if (
    name.endsWith(".xlsx") ||
    name.endsWith(".xls") ||
    mime ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mime === "application/vnd.ms-excel"
  ) {
    const buffer = await file.arrayBuffer();
    return parseExcel(buffer);
  }

  throw new Error(
    "Unsupported file type. Please upload a .csv, .xlsx, or .xls file."
  );
}

function displayValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join("|");
  return String(value);
}

function validateBucket(
  entity: UploadEntityKind,
  rows: Record<string, unknown>[]
): { issuesByRow: Map<number, RowValidationIssue[]>; validCount: number } {
  const schema =
    entity === "teacher"
      ? teacherRowSchema
      : entity === "subject"
        ? subjectRowSchema
        : entity === "room"
          ? roomRowSchema
          : entity === "classGroup"
            ? classGroupRowSchema
            : timeSlotRowSchema;

  const idField = "id";
  const { issues } = validateEntityRows(
    schema,
    rows,
    idField,
    entity === "timeSlot" ? timeSlotUniqueKey : undefined
  );
  const issuesByRow = new Map<number, RowValidationIssue[]>();

  for (const issue of issues) {
    const list = issuesByRow.get(issue.rowIndex) ?? [];
    list.push(issue);
    issuesByRow.set(issue.rowIndex, list);
  }

  return {
    issuesByRow,
    validCount: rows.length - issuesByRow.size,
  };
}

/** Build preview + buckets from raw parsed objects */
export function buildParsedUploadState(
  rawRows: Record<string, unknown>[]
): ParsedUploadState {
  const teachers: Record<string, unknown>[] = [];
  const subjects: Record<string, unknown>[] = [];
  const rooms: Record<string, unknown>[] = [];
  const classGroups: Record<string, unknown>[] = [];
  const timeSlots: Record<string, unknown>[] = [];

  const indexed: Array<{
    entity: UploadEntityKind;
    localIndex: number;
    raw: Record<string, unknown>;
  }> = [];

  rawRows.forEach((raw, globalIndex) => {
    const entity = detectEntity(raw);
    if (!entity) return;

    const { entity: _e, Entity: _E, ...rest } = raw as Record<string, unknown> & {
      entity?: unknown;
      Entity?: unknown;
    };

    let localIndex = 0;
    if (entity === "teacher") {
      localIndex = teachers.length;
      teachers.push(rest);
    } else if (entity === "subject") {
      localIndex = subjects.length;
      subjects.push(rest);
    } else if (entity === "room") {
      localIndex = rooms.length;
      rooms.push(rest);
    } else if (entity === "classGroup") {
      localIndex = classGroups.length;
      classGroups.push(rest);
    } else {
      localIndex = timeSlots.length;
      timeSlots.push(rest);
    }

    indexed.push({ entity, localIndex, raw: { ...rest, entity } });
    void globalIndex;
  });

  const teacherIssues = validateBucket("teacher", teachers).issuesByRow;
  const subjectIssues = validateBucket("subject", subjects).issuesByRow;
  const roomIssues = validateBucket("room", rooms).issuesByRow;
  const classGroupIssues = validateBucket("classGroup", classGroups).issuesByRow;
  const timeSlotIssues = validateBucket("timeSlot", timeSlots).issuesByRow;

  const issueMap: Record<UploadEntityKind, Map<number, RowValidationIssue[]>> = {
    teacher: teacherIssues,
    subject: subjectIssues,
    room: roomIssues,
    classGroup: classGroupIssues,
    timeSlot: timeSlotIssues,
  };

  const previewRows: PreviewRow[] = indexed.map((item, idx) => {
    const issues = issueMap[item.entity].get(item.localIndex) ?? [];
    const headers = ENTITY_HEADERS[item.entity];
    const values: Record<string, string> = { entity: item.entity };
    for (const h of headers) {
      values[h] = displayValue(item.raw[h]);
    }
    return {
      key: `${item.entity}-${item.localIndex}-${idx}`,
      rowIndex: item.localIndex,
      entity: item.entity,
      raw: item.raw,
      values,
      issues,
    };
  });

  const errorRowCount = previewRows.filter((r) => r.issues.length > 0).length;

  return {
    teachers,
    subjects,
    rooms,
    classGroups,
    timeSlots,
    previewRows,
    errorRowCount,
    totalRowCount: previewRows.length,
  };
}

export function scheduleInputToCsv(input: ScheduleInput): string {
  const lines: string[] = [];
  const escape = (v: unknown) => {
    const s = v == null ? "" : Array.isArray(v) ? v.join("|") : String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  lines.push(
    [
      "entity",
      "id",
      "name",
      "maxHoursPerDay",
      "maxHoursPerWeek",
      "unavailableSlots",
      "code",
      "periodsPerWeek",
      "requiredRoomType",
      "assignedTeacherId",
      "classGroupId",
      "lockedSlots",
      "type",
      "capacity",
      "groupName",
      "studentCount",
      "department",
      "parallelGroupIds",
      "day",
      "period",
      "startTime",
      "endTime",
    ].join(",")
  );

  for (const t of input.teachers) {
    lines.push(
      [
        "teacher",
        t.id,
        t.name,
        t.maxHoursPerDay,
        t.maxHoursPerWeek,
        t.unavailableSlots.join("|"),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]
        .map(escape)
        .join(",")
    );
  }

  for (const s of input.subjects) {
    lines.push(
      [
        "subject",
        s.id,
        s.name,
        "",
        "",
        "",
        s.code,
        s.periodsPerWeek,
        s.requiredRoomType,
        s.assignedTeacherId,
        s.classGroupId,
        (s.lockedSlots ?? []).join("|"),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]
        .map(escape)
        .join(",")
    );
  }

  for (const r of input.rooms) {
    lines.push(
      [
        "room",
        r.id,
        r.name,
        "",
        "",
        (r.unavailableSlots ?? []).join("|"),
        "",
        "",
        "",
        "",
        "",
        "",
        r.type,
        r.capacity,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
      ]
        .map(escape)
        .join(",")
    );
  }

  for (const g of input.classGroups) {
    lines.push(
      [
        "classGroup",
        g.id,
        "",
        "",
        "",
        (g.unavailableSlots ?? []).join("|"),
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        g.groupName,
        g.studentCount,
        g.department,
        g.parallelGroupIds.join("|"),
        "",
        "",
        "",
        "",
      ]
        .map(escape)
        .join(",")
    );
  }

  for (const slot of input.timeSlots) {
    lines.push(
      [
        "timeSlot",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        slot.day,
        slot.period,
        slot.startTime,
        slot.endTime,
      ]
        .map(escape)
        .join(",")
    );
  }

  return lines.join("\n");
}

export function downloadMockDataset(size: DatasetSize): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const input = generateMockDataset(size);
  const csv = scheduleInputToCsv(input);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `timetable-template-${size}-${DATASET_ROW_TARGETS[size]}rows.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Multi-sheet Excel template (Teachers / Subjects / Rooms / ClassGroups / TimeSlots) */
export async function downloadExcelTemplate(
  size: DatasetSize = "medium"
): Promise<void> {
  if (typeof window === "undefined") return;
  const XLSX = await loadXlsx();
  const input = generateMockDataset(size);
  const workbook = XLSX.utils.book_new();

  const teachers = input.teachers.map((t) => ({
    id: t.id,
    name: t.name,
    maxHoursPerDay: t.maxHoursPerDay,
    maxHoursPerWeek: t.maxHoursPerWeek,
    unavailableSlots: t.unavailableSlots.join("|"),
  }));

  const subjects = input.subjects.map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    periodsPerWeek: s.periodsPerWeek,
    requiredRoomType: s.requiredRoomType,
    assignedTeacherId: s.assignedTeacherId,
    classGroupId: s.classGroupId,
    lockedSlots: (s.lockedSlots ?? []).join("|"),
  }));

  const rooms = input.rooms.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    capacity: r.capacity,
    unavailableSlots: (r.unavailableSlots ?? []).join("|"),
  }));

  const classGroups = input.classGroups.map((g) => ({
    id: g.id,
    groupName: g.groupName,
    studentCount: g.studentCount,
    department: g.department,
    parallelGroupIds: g.parallelGroupIds.join("|"),
    unavailableSlots: (g.unavailableSlots ?? []).join("|"),
  }));

  const timeSlots = input.timeSlots.map((s) => ({
    day: s.day,
    period: s.period,
    startTime: s.startTime,
    endTime: s.endTime,
  }));

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(teachers),
    "Teachers"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(subjects),
    "Subjects"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(rooms),
    "Rooms"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(classGroups),
    "ClassGroups"
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(timeSlots),
    "TimeSlots"
  );

  XLSX.writeFile(
    workbook,
    `timetable-template-${size}-${DATASET_ROW_TARGETS[size]}rows.xlsx`
  );
}

export function buildScheduleInputFromState(
  state: ParsedUploadState
): { input: ScheduleInput | null; blockingErrors: string[] } {
  const blockingErrors: string[] = [];

  const teachersResult = validateEntityRows(teacherRowSchema, state.teachers);
  const subjectsResult = validateEntityRows(subjectRowSchema, state.subjects);
  const roomsResult = validateEntityRows(roomRowSchema, state.rooms);
  const groupsResult = validateEntityRows(classGroupRowSchema, state.classGroups);
  const slotsResult = validateEntityRows(
    timeSlotRowSchema,
    state.timeSlots,
    "id",
    timeSlotUniqueKey
  );

  if (teachersResult.issues.length) {
    blockingErrors.push(`Teachers: ${teachersResult.issues.length} issue(s)`);
  }
  if (subjectsResult.issues.length) {
    blockingErrors.push(`Subjects: ${subjectsResult.issues.length} issue(s)`);
  }
  if (roomsResult.issues.length) {
    blockingErrors.push(`Rooms: ${roomsResult.issues.length} issue(s)`);
  }
  if (groupsResult.issues.length) {
    blockingErrors.push(`Class groups: ${groupsResult.issues.length} issue(s)`);
  }
  if (slotsResult.issues.length && state.timeSlots.length > 0) {
    blockingErrors.push(`Time slots: ${slotsResult.issues.length} issue(s)`);
  }

  if (
    teachersResult.data.length === 0 ||
    subjectsResult.data.length === 0 ||
    roomsResult.data.length === 0 ||
    groupsResult.data.length === 0
  ) {
    blockingErrors.push(
      "Need at least one valid teacher, subject, room, and class group."
    );
  }

  if (blockingErrors.length) {
    return { input: null, blockingErrors };
  }

  const timeSlots: TimeSlot[] =
    slotsResult.data.length > 0
      ? (slotsResult.data as TimeSlotRow[])
      : generateDefaultTimeSlots();

  const input: ScheduleInput = {
    teachers: teachersResult.data as unknown as Teacher[],
    subjects: subjectsResult.data as unknown as ScheduleInput["subjects"],
    rooms: roomsResult.data as unknown as ScheduleInput["rooms"],
    classGroups: groupsResult.data as unknown as ScheduleInput["classGroups"],
    timeSlots,
  };

  return { input, blockingErrors: [] };
}
