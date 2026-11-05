import type { AnyConstraintRule } from "./types";
import { hardRules } from "./hardRules";
import { softRules } from "./softRules";

export * from "./types";
export * from "./hardRules";
export * from "./softRules";

/** Full constraint set used by the scheduling evaluator */
export const allRules: AnyConstraintRule[] = [...hardRules, ...softRules];
