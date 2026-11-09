/** Core domain types for the AI Automatic Timetable Generator */

export type DayOfWeek = "MON" | "TUE" | "WED" | "THU" | "FRI";

/** RFC 5545 weekday codes for iCalendar RRULE BYDAY */
export type IcalWeekday = "MO" | "TU" | "WE" | "TH" | "FR";

export const DAY_TO_ICAL_WEEKDAY: Record<DayOfWeek, IcalWeekday> = {
  MON: "MO",
  TUE: "TU",
  WED: "WE",
  THU: "TH",
  FRI: "FR",
};

export type RoomType = "THEORY" | "LAB" | "SPECIFIC";

export type ConstraintSeverity = "HARD" | "SOFT";

export type ConstraintCode =
  | "H1"
  | "H2"
  | "H3"
  | "H4"
  | "H5"
  | "H6"
  | "H7"
  | "H8"
  | "S1"
  | "S2"
  | "S3"
  | "S4";

/** Compact slot id used in unavailableSlots, e.g. "MON_P1" */
export type TimeSlotId = `${DayOfWeek}_P${number}`;

export interface TimeSlot {
  day: DayOfWeek;
  /** Period index within the day (1–8) */
  period: number;
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export interface Teacher {
  id: string;
  name: string;
  maxHoursPerDay: number;
  maxHoursPerWeek: number;
  unavailableSlots: TimeSlotId[];
}

export interface Subject {
  id: string;
  code: string;
  name: string;
  periodsPerWeek: number;
  requiredRoomType: RoomType;
  assignedTeacherId: string;
  /** Class group that takes this subject (used for CSP demand expansion) */
  classGroupId: string;
}

export interface Room {
  id: string;
  name: string;
  type: RoomType;
  capacity: number;
}

export interface ClassGroup {
  id: string;
  groupName: string;
  studentCount: number;
  department: string;
  /** Parallel groups that must not overlap in time */
  parallelGroupIds: string[];
}

/** Individual student enrolled in a class group */
export interface Student {
  id: string;
  name: string;
  classGroupId: string;
}

/** A single placed lesson in a generated timetable */
export interface ScheduleAssignment {
  id: string;
  subjectId: string;
  teacherId: string;
  roomId: string;
  classGroupId: string;
  timeSlot: TimeSlot;
  /** Optional run / generation batch this assignment belongs to */
  scheduleRunId?: string;
}

export interface ConflictReport {
  id: string;
  code: ConstraintCode;
  severity: ConstraintSeverity;
  message: string;
  /** Assignment ids involved in the conflict */
  assignmentIds: string[];
  /** Optional entity ids for UI highlighting */
  entityIds?: {
    teacherId?: string;
    roomId?: string;
    classGroupId?: string;
    subjectId?: string;
  };
  /** Soft-constraint penalty weight (0 for hard) */
  penalty: number;
}

/** Aggregated input set fed to the scheduling engine */
export interface ScheduleInput {
  teachers: Teacher[];
  subjects: Subject[];
  rooms: Room[];
  classGroups: ClassGroup[];
  timeSlots: TimeSlot[];
  /** Optional individual student roster (synthesized for demos when absent) */
  students?: Student[];
}

/** Engine output after a solve attempt */
export interface ScheduleResult {
  assignments: ScheduleAssignment[];
  conflicts: ConflictReport[];
  hardConflictCount: number;
  softPenaltyTotal: number;
  fitnessScore: number;
  seed: number;
  /** Alias of wall-clock solve duration (same value as executionTimeMs) */
  elapsedMs: number;
  executionTimeMs: number;
  /** Unique used room-slots / (rooms × timeSlots) × 100 */
  roomUtilizationPercent: number;
  /** 1 - (stdev / mean) of teacher hours, clamped to [0, 1] */
  teacherWorkloadBalance: number;
  /** assignedSlots / totalRequiredSlots × 100 */
  completionRate: number;
  /** True when solver returned a feasible partial (timeout / incomplete) */
  isPartial: boolean;
  /** True when wall-clock budget was exhausted during search */
  timedOut?: boolean;
  /** Total lesson demands expanded from subjects */
  totalRequiredSlots?: number;
}
