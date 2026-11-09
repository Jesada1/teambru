import type { ClassGroup, ScheduleInput, Student } from "../types/schedule";

function pad(n: number, width = 3): string {
  return String(n).padStart(width, "0");
}

/**
 * Synthesize individual students from class groups when upload/mock
 * data does not include an explicit roster (competition demo mode).
 */
export function synthesizeStudentsFromGroups(
  classGroups: ClassGroup[],
  maxPerGroup = 5
): Student[] {
  const students: Student[] = [];
  let seq = 1;
  for (const group of classGroups) {
    const count = Math.min(
      Math.max(1, group.studentCount || 1),
      maxPerGroup
    );
    for (let i = 0; i < count; i++) {
      students.push({
        id: `STU${pad(seq)}`,
        name: `นักเรียน ${seq}`,
        classGroupId: group.id,
      });
      seq += 1;
    }
  }
  return students;
}

/** Prefer explicit roster; otherwise synthesize a compact demo roster. */
export function resolveStudents(input: ScheduleInput): Student[] {
  if (input.students && input.students.length > 0) {
    return input.students;
  }
  return synthesizeStudentsFromGroups(input.classGroups);
}

/** Attach synthesized students onto a schedule input (non-mutating copy). */
export function withStudents(input: ScheduleInput): ScheduleInput {
  if (input.students && input.students.length > 0) return input;
  return {
    ...input,
    students: synthesizeStudentsFromGroups(input.classGroups),
  };
}
