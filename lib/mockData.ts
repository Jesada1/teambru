import type {
  ClassGroup,
  DayOfWeek,
  Room,
  RoomType,
  ScheduleInput,
  Subject,
  Teacher,
  TimeSlot,
  TimeSlotId,
} from "../types/schedule";

export type DatasetSize = "small" | "medium" | "large";

/** Approximate total entity rows generated for each preset */
export const DATASET_ROW_TARGETS: Record<DatasetSize, number> = {
  small: 10,
  medium: 50,
  large: 200,
};

const DAYS: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI"];
const ROOM_TYPES: RoomType[] = ["THEORY", "LAB", "SPECIFIC"];
const DEPARTMENTS = ["AI", "IT", "Business", "Engineering", "Design"];

const PERIOD_TIMES: Array<{ startTime: string; endTime: string }> = [
  { startTime: "08:30", endTime: "09:30" },
  { startTime: "09:30", endTime: "10:30" },
  { startTime: "10:45", endTime: "11:45" },
  { startTime: "11:45", endTime: "12:45" },
  { startTime: "13:30", endTime: "14:30" },
  { startTime: "14:30", endTime: "15:30" },
  { startTime: "15:45", endTime: "16:45" },
  { startTime: "16:45", endTime: "17:45" },
];

export function generateDefaultTimeSlots(): TimeSlot[] {
  const slots: TimeSlot[] = [];
  for (const day of DAYS) {
    PERIOD_TIMES.forEach((times, index) => {
      slots.push({
        day,
        period: index + 1,
        startTime: times.startTime,
        endTime: times.endTime,
      });
    });
  }
  return slots;
}

function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

function pickUnavailableSlots(seed: number, count: number): TimeSlotId[] {
  const slots: TimeSlotId[] = [];
  for (let i = 0; i < count; i++) {
    const day = DAYS[(seed + i * 3) % DAYS.length];
    const period = ((seed + i * 5) % 8) + 1;
    slots.push(`${day}_P${period}` as TimeSlotId);
  }
  return [...new Set(slots)];
}

/**
 * Splits a target row budget across entity kinds.
 * Teachers + subjects + rooms + classGroups ≈ targetRows.
 */
function splitBudget(targetRows: number): {
  teachers: number;
  subjects: number;
  rooms: number;
  classGroups: number;
} {
  const teachers = Math.max(2, Math.round(targetRows * 0.2));
  const rooms = Math.max(2, Math.round(targetRows * 0.2));
  const classGroups = Math.max(2, Math.round(targetRows * 0.2));
  const subjects = Math.max(2, targetRows - teachers - rooms - classGroups);
  return { teachers, subjects, rooms, classGroups };
}

export function generateTeachers(count: number): Teacher[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      id: `T${pad(n)}`,
      name: `Teacher ${n}`,
      maxHoursPerDay: 6,
      maxHoursPerWeek: 20 + (n % 5) * 2,
      unavailableSlots: pickUnavailableSlots(n, n % 3),
    };
  });
}

export function generateRooms(count: number): Room[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const type = ROOM_TYPES[i % ROOM_TYPES.length];
    return {
      id: `R${pad(n)}`,
      name: `${type === "LAB" ? "Lab" : type === "SPECIFIC" ? "Special" : "Room"} ${n}`,
      type,
      capacity: type === "LAB" ? 30 + (n % 3) * 5 : 40 + (n % 4) * 10,
    };
  });
}

export function generateClassGroups(count: number): ClassGroup[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const department = DEPARTMENTS[i % DEPARTMENTS.length];
    const parallelPartner =
      count > 1 && n % 2 === 0 ? `G${pad(n - 1)}` : undefined;

    return {
      id: `G${pad(n)}`,
      groupName: `${department}-ปวส.${((n - 1) % 3) + 1}`,
      studentCount: 20 + (n % 15),
      department,
      parallelGroupIds: parallelPartner ? [parallelPartner] : [],
    };
  });
}

export function generateSubjects(
  count: number,
  teachers: Teacher[],
  rooms: Room[],
  classGroups: ClassGroup[]
): Subject[] {
  const roomTypes = rooms.map((r) => r.type);
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const teacher = teachers[i % teachers.length];
    const classGroup = classGroups[i % classGroups.length];
    const requiredRoomType = roomTypes[i % roomTypes.length] ?? "THEORY";

    return {
      id: `S${pad(n)}`,
      code: `SUB${pad(n)}`,
      name: `Subject ${n}`,
      periodsPerWeek: 2 + (n % 3),
      requiredRoomType,
      assignedTeacherId: teacher.id,
      classGroupId: classGroup.id,
    };
  });
}

export function generateMockDataset(size: DatasetSize): ScheduleInput {
  const budget = splitBudget(DATASET_ROW_TARGETS[size]);
  const teachers = generateTeachers(budget.teachers);
  const rooms = generateRooms(budget.rooms);
  const classGroups = generateClassGroups(budget.classGroups);
  const subjects = generateSubjects(
    budget.subjects,
    teachers,
    rooms,
    classGroups
  );
  const timeSlots = generateDefaultTimeSlots();

  return { teachers, subjects, rooms, classGroups, timeSlots };
}

export function generateSmallDataset(): ScheduleInput {
  return generateMockDataset("small");
}

export function generateMediumDataset(): ScheduleInput {
  return generateMockDataset("medium");
}

export function generateLargeDataset(): ScheduleInput {
  return generateMockDataset("large");
}

/** Flat row count across the four uploadable entity collections (excludes timeSlots) */
export function countEntityRows(input: ScheduleInput): number {
  return (
    input.teachers.length +
    input.subjects.length +
    input.rooms.length +
    input.classGroups.length
  );
}
