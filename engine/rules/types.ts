import type {
  ClassGroup,
  ConflictReport,
  ConstraintCode,
  ConstraintSeverity,
  Room,
  ScheduleAssignment,
  ScheduleInput,
  Subject,
  Teacher,
  TimeSlot,
} from "../../types/schedule";

/** Shared read-only context passed into every constraint rule */
export interface ConstraintContext {
  input: ScheduleInput;
  assignments: ScheduleAssignment[];
  teachersById: Map<string, Teacher>;
  subjectsById: Map<string, Subject>;
  roomsById: Map<string, Room>;
  classGroupsById: Map<string, ClassGroup>;
  timeSlotsByKey: Map<string, TimeSlot>;
}

export interface RuleEvaluationResult {
  /** True when this rule finds no violations / soft penalties */
  satisfied: boolean;
  conflicts: ConflictReport[];
  /** Soft rules return a non-negative penalty; hard rules should return 0 */
  penalty: number;
}

/** Base strategy contract shared by hard and soft rules */
export interface ConstraintRule {
  readonly code: ConstraintCode;
  readonly name: string;
  readonly description: string;
  readonly severity: ConstraintSeverity;
  evaluate(context: ConstraintContext): RuleEvaluationResult;
}

/** Hard constraints must return zero conflicts for a valid timetable */
export interface HardConstraintRule extends ConstraintRule {
  readonly severity: "HARD";
}

/** Soft constraints contribute weighted penalties to the fitness score */
export interface SoftConstraintRule extends ConstraintRule {
  readonly severity: "SOFT";
  /** Higher weight = stronger preference during optimization */
  readonly weight: number;
}

export type AnyConstraintRule = HardConstraintRule | SoftConstraintRule;

export function isHardRule(rule: ConstraintRule): rule is HardConstraintRule {
  return rule.severity === "HARD";
}

export function isSoftRule(rule: ConstraintRule): rule is SoftConstraintRule {
  return rule.severity === "SOFT";
}

/** Builds lookup maps once per evaluate/solve cycle */
export function buildConstraintContext(
  input: ScheduleInput,
  assignments: ScheduleAssignment[]
): ConstraintContext {
  return {
    input,
    assignments,
    teachersById: new Map(input.teachers.map((t) => [t.id, t])),
    subjectsById: new Map(input.subjects.map((s) => [s.id, s])),
    roomsById: new Map(input.rooms.map((r) => [r.id, r])),
    classGroupsById: new Map(input.classGroups.map((g) => [g.id, g])),
    timeSlotsByKey: new Map(
      input.timeSlots.map((slot) => [`${slot.day}_P${slot.period}`, slot])
    ),
  };
}

/** Runs a rule set and aggregates hard conflicts + soft penalties */
export function evaluateRules(
  rules: AnyConstraintRule[],
  context: ConstraintContext
): {
  conflicts: ConflictReport[];
  hardConflictCount: number;
  softPenaltyTotal: number;
} {
  const conflicts: ConflictReport[] = [];
  let hardConflictCount = 0;
  let softPenaltyTotal = 0;

  for (const rule of rules) {
    const result = rule.evaluate(context);
    conflicts.push(...result.conflicts);

    if (isHardRule(rule)) {
      hardConflictCount += result.conflicts.length;
    } else {
      softPenaltyTotal += result.penalty * rule.weight;
    }
  }

  return { conflicts, hardConflictCount, softPenaltyTotal };
}
