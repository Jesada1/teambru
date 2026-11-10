import { z } from "zod";

const dayOfWeekSchema = z.enum(["MON", "TUE", "WED", "THU", "FRI"]);
const roomTypeSchema = z.enum(["THEORY", "LAB", "SPECIFIC"]);

/** Accepts "MON_P1" style ids or "HH:MM-HH:MM" range strings */
const timeSlotTokenSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      /^(MON|TUE|WED|THU|FRI)_P([1-8])$/.test(value) ||
      /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value),
    { message: "Time slot must be like MON_P1 or HH:MM-HH:MM" }
  );

const csvListSchema = z
  .union([z.string(), z.array(z.string())])
  .transform((value) => {
    if (Array.isArray(value)) {
      return value.map((item) => item.trim()).filter(Boolean);
    }
    if (!value.trim()) return [] as string[];
    return value
      .split(/[|;,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  });

const positiveIntSchema = z.coerce.number().int().positive();
const nonNegativeIntSchema = z.coerce.number().int().nonnegative();

export const teacherRowSchema = z.object({
  id: z.string().trim().min(1, "Teacher id is required"),
  name: z.string().trim().min(1, "Teacher name is required"),
  maxHoursPerDay: z.coerce.number().int().positive().default(6),
  maxHoursPerWeek: positiveIntSchema,
  unavailableSlots: csvListSchema.pipe(z.array(timeSlotTokenSchema)).default([]),
});

export const subjectRowSchema = z.object({
  id: z.string().trim().min(1, "Subject id is required"),
  code: z.string().trim().min(1, "Subject code is required"),
  name: z.string().trim().min(1, "Subject name is required"),
  periodsPerWeek: positiveIntSchema,
  requiredRoomType: roomTypeSchema,
  assignedTeacherId: z.string().trim().min(1, "assignedTeacherId is required"),
  classGroupId: z.string().trim().min(1, "classGroupId is required"),
  lockedSlots: csvListSchema.pipe(z.array(timeSlotTokenSchema)).default([]),
});

export const roomRowSchema = z.object({
  id: z.string().trim().min(1, "Room id is required"),
  name: z.string().trim().min(1, "Room name is required"),
  type: roomTypeSchema,
  capacity: positiveIntSchema,
  unavailableSlots: csvListSchema.pipe(z.array(timeSlotTokenSchema)).default([]),
});

export const classGroupRowSchema = z.object({
  id: z.string().trim().min(1, "Class group id is required"),
  groupName: z.string().trim().min(1, "groupName is required"),
  studentCount: nonNegativeIntSchema,
  department: z.string().trim().min(1, "department is required"),
  parallelGroupIds: csvListSchema.default([]),
  unavailableSlots: csvListSchema.pipe(z.array(timeSlotTokenSchema)).default([]),
});

export const timeSlotRowSchema = z.object({
  day: dayOfWeekSchema,
  period: z.coerce.number().int().min(1).max(8),
  startTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "startTime must be HH:MM"),
  endTime: z
    .string()
    .trim()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "endTime must be HH:MM"),
});

export const uploadBundleSchema = z.object({
  teachers: z.array(teacherRowSchema).min(1),
  subjects: z.array(subjectRowSchema).min(1),
  rooms: z.array(roomRowSchema).min(1),
  classGroups: z.array(classGroupRowSchema).min(1),
  timeSlots: z.array(timeSlotRowSchema).optional(),
});

export type TeacherRowInput = z.input<typeof teacherRowSchema>;
export type TeacherRow = z.output<typeof teacherRowSchema>;
export type SubjectRowInput = z.input<typeof subjectRowSchema>;
export type SubjectRow = z.output<typeof subjectRowSchema>;
export type RoomRowInput = z.input<typeof roomRowSchema>;
export type RoomRow = z.output<typeof roomRowSchema>;
export type ClassGroupRowInput = z.input<typeof classGroupRowSchema>;
export type ClassGroupRow = z.output<typeof classGroupRowSchema>;
export type TimeSlotRowInput = z.input<typeof timeSlotRowSchema>;
export type TimeSlotRow = z.output<typeof timeSlotRowSchema>;
export type UploadBundle = z.output<typeof uploadBundleSchema>;

export type RowValidationIssue = {
  rowIndex: number;
  field?: string;
  message: string;
  code: "duplicate_id" | "missing_field" | "invalid_format" | "capacity" | "teacher_capacity";
};

export type UniqueKeyFn = (parsed: Record<string, unknown>) => string | null;

/** Composite uniqueness for time slots: day+period (fallback day+startTime) */
export function timeSlotUniqueKey(parsed: Record<string, unknown>): string | null {
  const day = String(parsed.day ?? "").trim();
  if (!day) return null;
  if (parsed.period != null && String(parsed.period).trim() !== "") {
    return `${day}|P${parsed.period}`;
  }
  const start = String(parsed.startTime ?? "").trim();
  if (start) return `${day}|${start}`;
  return day;
}

/**
 * Validates a single entity row collection and reports duplicate ids.
 * Does not throw — returns parsed rows + issues for the preview grid.
 */
export function validateEntityRows<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  rows: unknown[],
  idField: string = "id",
  uniqueKey?: UniqueKeyFn
): { data: z.output<TSchema>[]; issues: RowValidationIssue[] } {
  const data: z.output<TSchema>[] = [];
  const issues: RowValidationIssue[] = [];
  const seenIds = new Map<string, number>();

  rows.forEach((row, rowIndex) => {
    const result = schema.safeParse(row);

    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path.join(".") || undefined;
        const isMissing =
          issue.code === "invalid_type" ||
          issue.message.toLowerCase().includes("required");

        issues.push({
          rowIndex,
          field,
          message: issue.message,
          code: isMissing ? "missing_field" : "invalid_format",
        });
      }
      return;
    }

    const parsed = result.data as Record<string, unknown>;
    const key =
      uniqueKey?.(parsed) ??
      (parsed[idField] != null && String(parsed[idField]).trim() !== ""
        ? String(parsed[idField])
        : "");

    const dupField =
      uniqueKey && key.includes("|")
        ? key.includes("|P")
          ? "period"
          : "startTime"
        : idField;

    if (key && seenIds.has(key)) {
      issues.push({
        rowIndex,
        field: dupField,
        message: `Duplicate ${dupField === "id" ? "id" : "time slot"} "${key}" (also at row ${seenIds.get(key)})`,
        code: "duplicate_id",
      });
    } else if (key) {
      seenIds.set(key, rowIndex);
    }

    data.push(result.data);
  });

  return { data, issues };
}
