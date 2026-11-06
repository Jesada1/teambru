import type { NextApiRequest, NextApiResponse } from "next";
import {
  AgentConstraintSchema,
  parseAgentPrompt,
  type AgentConstraint,
} from "../../../lib/agentSchema";
import { applyDynamicConstraintSafely } from "../../../lib/csp-engine";
import type { ScheduleInput, ScheduleResult } from "../../../types/schedule";

/**
 * Pages-router mirror of app/api/schedule/agent for hybrid Next setups.
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.body as {
      prompt?: string;
      constraint?: unknown;
      input?: ScheduleInput;
      result?: ScheduleResult;
    };

    if (!body?.input || !body?.result) {
      return res.status(400).json({
        ok: false,
        error: "Missing schedule input/result payload",
        code: "MISSING_SCHEDULE",
      });
    }

    let constraint: AgentConstraint | null = null;

    if (body.constraint != null) {
      const parsed = AgentConstraintSchema.safeParse(body.constraint);
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: parsed.error.flatten(),
        });
      }
      constraint = parsed.data;
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      constraint = parseAgentPrompt(
        body.prompt,
        body.input.teachers.map((t) => ({ id: t.id, name: t.name }))
      );
      if (!constraint) {
        return res.status(400).json({
          ok: false,
          error:
            "ไม่สามารถตีความคำสั่งได้ กรุณาระบุครู วัน และคาบให้ชัดเจน",
          code: "PARSE_FAILED",
        });
      }
      const recheck = AgentConstraintSchema.safeParse(constraint);
      if (!recheck.success) {
        return res.status(400).json({
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: recheck.error.flatten(),
        });
      }
      constraint = recheck.data;
    } else {
      return res.status(400).json({
        ok: false,
        error: "Provide either prompt or constraint",
        code: "MISSING_PROMPT",
      });
    }

    const outcome = applyDynamicConstraintSafely(
      body.input,
      body.result,
      constraint
    );

    if (!outcome.ok) {
      return res.status(422).json({
        ok: false,
        error: outcome.error,
        code: outcome.code,
        rolledBack: true,
        status: "rollback",
      });
    }

    return res.status(200).json({
      ok: true,
      status: "applied",
      message: outcome.message,
      appliedAction: outcome.appliedAction,
      constraint,
      result: outcome.result,
      hardConflictCount: outcome.result.hardConflictCount,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Agent engine failed unexpectedly — schedule unchanged",
      code: "ENGINE_ERROR",
      rolledBack: true,
      status: "rollback",
    });
  }
}
