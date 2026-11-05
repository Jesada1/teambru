import type { DayOfWeek, RoomType } from "../../types/schedule";
import {
  classGroupRowSchema,
  roomRowSchema,
  subjectRowSchema,
  teacherRowSchema,
  timeSlotRowSchema,
  type ClassGroupRow,
  type RoomRow,
  type RowValidationIssue,
  type SubjectRow,
  type TeacherRow,
  type TimeSlotRow,
} from "./upload";

export type UploadEntityKind =
  | "teacher"
  | "subject"
  | "room"
  | "classGroup"
  | "timeSlot";

/** Raw upload row that failed initial Zod validation */
export type InvalidRow = {
  rowIndex: number;
  entity: UploadEntityKind;
  raw: Record<string, unknown>;
  issues?: RowValidationIssue[];
};

/** Successfully auto-fixed & re-validated row */
export type ValidRow =
  | { entity: "teacher"; rowIndex: number; data: TeacherRow }
  | { entity: "subject"; rowIndex: number; data: SubjectRow }
  | { entity: "room"; rowIndex: number; data: RoomRow }
  | { entity: "classGroup"; rowIndex: number; data: ClassGroupRow }
  | { entity: "timeSlot"; rowIndex: number; data: TimeSlotRow };

export type AutoFixResult = {
  fixedRows: ValidRow[];
  remainingErrors: InvalidRow[];
};

const DEFAULT_PERIOD_RANGES: Record<number, string> = {
  1: "08:30-09:30",
  2: "09:30-10:30",
  3: "10:45-11:45",
  4: "11:45-12:45",
  5: "13:30-14:30",
  6: "14:30-15:30",
  7: "15:45-16:45",
  8: "16:45-17:45",
};

const DAY_ALIASES: Record<string, DayOfWeek> = {
  mon: "MON",
  monday: "MON",
  tue: "TUE",
  tues: "TUE",
  tuesday: "TUE",
  wed: "WED",
  wednesday: "WED",
  thu: "THU",
  thur: "THU",
  thurs: "THU",
  thursday: "THU",
  fri: "FRI",
  friday: "FRI",
  MON: "MON",
  TUE: "TUE",
  WED: "WED",
  THU: "THU",
  FRI: "FRI",
};

const ROOM_TYPE_ALIASES: Record<string, RoomType> = {
  theory: "THEORY",
  lecture: "THEORY",
  classroom: "THEORY",
  lab: "LAB",
  laboratory: "LAB",
  practical: "LAB",
  specific: "SPECIFIC",
  special: "SPECIFIC",
  THEORY: "THEORY",
  LAB: "LAB",
  SPECIFIC: "SPECIFIC",
};

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}

/** Collapse whitespace and trim; leave non-strings untouched */
export function sanitizeString(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.replace(/\s+/g, " ").trim();
}

function padTimePart(part: string): string | null {
  const match = part.trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/**
 * Normalize free-form time tokens into `HH:MM-HH:MM`.
 * Also maps compact period ids like `MON_P1` / `P3` using default ranges.
 */
export function standardizeTimeSlot(value: unknown): string | unknown {
  if (typeof value !== "string") return value;
  const raw = value.replace(/\s+/g, " ").trim();
  if (!raw) return raw;

  // Compact day-period token: MON_P1 / mon-p1
  const dayPeriod = raw.match(
    /^(MON|TUE|WED|THU|FRI|mon|tue|wed|thu|fri)[_-]P?(\d{1})$/i
  );
  if (dayPeriod) {
    const period = Number(dayPeriod[2]);
    return DEFAULT_PERIOD_RANGES[period] ?? raw;
  }

  // Bare period: P1 / p3 / period 2
  const barePeriod = raw.match(/^(?:P|period\s*)([1-8])$/i);
  if (barePeriod) {
    return DEFAULT_PERIOD_RANGES[Number(barePeriod[1])] ?? raw;
  }

  // Range with flexible separators: 8:30-9:30 | 08.30 – 09.30 | 8:30 to 9:30
  const range = raw.match(
    /^(\d{1,2}[:.]\d{2})\s*(?:-|–|—|to)\s*(\d{1,2}[:.]\d{2})$/i
  );
  if (range) {
    const start = padTimePart(range[1]);
    const end = padTimePart(range[2]);
    if (start && end) return `${start}-${end}`;
  }

  // Single HH:MM — leave as-is after padding (caller may pair start/end)
  const single = padTimePart(raw);
  if (single) return single;

  return raw;
}

function standardizeTimeList(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => standardizeTimeSlot(sanitizeString(item)));
  }
  if (typeof value !== "string") return value;

  const cleaned = value.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  return cleaned
    .split(/[|;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => standardizeTimeSlot(part));
}

function normalizeDay(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.replace(/\s+/g, " ").trim();
  return DAY_ALIASES[key] ?? DAY_ALIASES[key.toLowerCase()] ?? key.toUpperCase();
}

function normalizeRoomType(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const key = value.replace(/\s+/g, " ").trim();
  return (
    ROOM_TYPE_ALIASES[key] ??
    ROOM_TYPE_ALIASES[key.toLowerCase()] ??
    key.toUpperCase()
  );
}

function applyFallbacks(
  entity: UploadEntityKind,
  row: Record<string, unknown>
): Record<string, unknown> {
  const next = { ...row };

  switch (entity) {
    case "teacher":
      if (isBlank(next.maxHoursPerDay)) next.maxHoursPerDay = 6;
      if (isBlank(next.maxHoursPerWeek)) next.maxHoursPerWeek = 20;
      if (isBlank(next.unavailableSlots)) next.unavailableSlots = [];
      if (isBlank(next.name) && !isBlank(next.id)) {
        next.name = `Teacher ${String(next.id)}`;
      }
      break;

    case "subject":
      if (isBlank(next.periodsPerWeek)) next.periodsPerWeek = 1;
      if (isBlank(next.requiredRoomType)) next.requiredRoomType = "THEORY";
      if (isBlank(next.code) && !isBlank(next.id)) {
        next.code = String(next.id);
      }
      if (isBlank(next.name) && !isBlank(next.code)) {
        next.name = String(next.code);
      }
      break;

    case "room":
      if (isBlank(next.id)) next.id = "TBD";
      if (isBlank(next.name)) next.name = "TBD";
      if (isBlank(next.type)) next.type = "THEORY";
      if (isBlank(next.capacity)) next.capacity = 40;
      break;

    case "classGroup":
      if (isBlank(next.studentCount)) next.studentCount = 0;
      if (isBlank(next.department)) next.department = "TBD";
      if (isBlank(next.parallelGroupIds)) next.parallelGroupIds = [];
      if (isBlank(next.groupName) && !isBlank(next.id)) {
        next.groupName = String(next.id);
      }
      break;

    case "timeSlot": {
      // Prefer a combined range field if present
      if (!isBlank(next.timeRange) || !isBlank(next.time)) {
        const range = standardizeTimeSlot(next.timeRange ?? next.time);
        if (typeof range === "string" && range.includes("-")) {
          const [start, end] = range.split("-");
          if (isBlank(next.startTime)) next.startTime = start;
          if (isBlank(next.endTime)) next.endTime = end;
        }
      }
      if (isBlank(next.startTime) && !isBlank(next.period)) {
        const period = Number(next.period);
        const range = DEFAULT_PERIOD_RANGES[period];
        if (range) {
          const [start, end] = range.split("-");
          next.startTime = start;
          next.endTime = end;
        }
      }
      if (isBlank(next.endTime) && typeof next.startTime === "string") {
        // leave for schema to reject if still invalid
      }
      break;
    }
  }

  return next;
}

function sanitizeRow(
  entity: UploadEntityKind,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    sanitized[key] = sanitizeString(value);
  }

  if ("day" in sanitized) sanitized.day = normalizeDay(sanitized.day);
  if ("type" in sanitized) sanitized.type = normalizeRoomType(sanitized.type);
  if ("requiredRoomType" in sanitized) {
    sanitized.requiredRoomType = normalizeRoomType(sanitized.requiredRoomType);
  }
  if ("unavailableSlots" in sanitized) {
    sanitized.unavailableSlots = standardizeTimeList(sanitized.unavailableSlots);
  }
  if ("startTime" in sanitized) {
    sanitized.startTime = standardizeTimeSlot(sanitized.startTime);
  }
  if ("endTime" in sanitized) {
    sanitized.endTime = standardizeTimeSlot(sanitized.endTime);
  }
  if ("timeRange" in sanitized) {
    sanitized.timeRange = standardizeTimeSlot(sanitized.timeRange);
  }
  if ("time" in sanitized) {
    sanitized.time = standardizeTimeSlot(sanitized.time);
  }

  // Period-id style slots already converted inside unavailableSlots list
  return applyFallbacks(entity, sanitized);
}

function schemaFor(entity: UploadEntityKind) {
  switch (entity) {
    case "teacher":
      return teacherRowSchema;
    case "subject":
      return subjectRowSchema;
    case "room":
      return roomRowSchema;
    case "classGroup":
      return classGroupRowSchema;
    case "timeSlot":
      return timeSlotRowSchema;
  }
}

function fingerprint(entity: UploadEntityKind, data: unknown): string {
  return `${entity}:${JSON.stringify(data)}`;
}

/** Stable dedupe key — timeSlots use day+period (or day+startTime) */
export function entityDedupeKey(
  entity: UploadEntityKind,
  data: Record<string, unknown>
): string {
  if (entity === "timeSlot") {
    const day = String(data.day ?? "").trim().toUpperCase();
    const period =
      data.period != null && String(data.period).trim() !== ""
        ? String(data.period).trim()
        : "";
    const start = String(data.startTime ?? "").trim();
    if (day && period) return `timeSlot:${day}|P${period}`;
    if (day && start) return `timeSlot:${day}|${start}`;
    return `timeSlot:${day}|${period}|${start}`;
  }

  if (typeof data.id === "string" && data.id.trim()) {
    return `${entity}:id:${data.id.trim()}`;
  }

  return fingerprint(entity, data);
}

function toValidRow(
  entity: UploadEntityKind,
  rowIndex: number,
  data: unknown
): ValidRow {
  switch (entity) {
    case "teacher":
      return { entity, rowIndex, data: data as TeacherRow };
    case "subject":
      return { entity, rowIndex, data: data as SubjectRow };
    case "room":
      return { entity, rowIndex, data: data as RoomRow };
    case "classGroup":
      return { entity, rowIndex, data: data as ClassGroupRow };
    case "timeSlot":
      return { entity, rowIndex, data: data as TimeSlotRow };
  }
}

function issuesFromZod(
  rowIndex: number,
  error: { issues: { path: PropertyKey[]; message: string; code: string }[] }
): RowValidationIssue[] {
  return error.issues.map((issue) => {
    const field = issue.path.map(String).join(".") || undefined;
    const isMissing =
      issue.code === "invalid_type" ||
      issue.message.toLowerCase().includes("required");
    return {
      rowIndex,
      field,
      message: issue.message,
      code: isMissing ? "missing_field" : "invalid_format",
    };
  });
}

/**
 * Attempt to repair upload rows:
 * trim/sanitize strings, normalize time formats to HH:MM-HH:MM,
 * fill optional defaults (e.g. Room name/id → "TBD"), and drop duplicates.
 * Time slots are deduped by composite key `day|period` (fallback `day|startTime`).
 */
export function autoFixRows(invalidRows: InvalidRow[]): AutoFixResult {
  const fixedRows: ValidRow[] = [];
  const remainingErrors: InvalidRow[] = [];
  const seen = new Set<string>();

  for (const row of invalidRows) {
    const cleaned = sanitizeRow(row.entity, row.raw ?? {});
    const schema = schemaFor(row.entity);
    const parsed = schema.safeParse(cleaned);

    if (!parsed.success) {
      remainingErrors.push({
        rowIndex: row.rowIndex,
        entity: row.entity,
        raw: cleaned,
        issues: issuesFromZod(row.rowIndex, parsed.error),
      });
      continue;
    }

    const data = parsed.data as Record<string, unknown>;
    const key = entityDedupeKey(row.entity, data);

    // True duplicates (esp. timeSlot day+period) — drop cleanly
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    fixedRows.push(toValidRow(row.entity, row.rowIndex, parsed.data));
  }

  return { fixedRows, remainingErrors };
}
