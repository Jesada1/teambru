import type { NextApiRequest, NextApiResponse } from "next";
import {
  AgentConstraintSchema,
  parseAgentPrompt,
  type AgentConstraint,
} from "../../../lib/agentSchema";
import { applyDynamicConstraintSafely } from "../../../lib/csp-engine";
import type { ScheduleInput, ScheduleResult } from "../../../types/schedule";

/**
 * POST /api/schedule/agent — Plan → Act → Check agent pipeline.
 * PLAN: NL → JSON rules · ACT: sandboxed CSP mutation · CHECK: 0 hard conflicts
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
        pipeline: {
          status: "rollback",
          steps: [
            {
              stage: "PLAN",
              status: "fail",
              message: "Missing schedule input/result payload",
            },
          ],
        },
      });
    }

    let constraint: AgentConstraint | null = null;
    const planNotes: string[] = [];

    if (body.constraint != null) {
      const parsed = AgentConstraintSchema.safeParse(body.constraint);
      if (!parsed.success) {
        return res.status(400).json({
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: parsed.error.flatten(),
          pipeline: {
            status: "rollback",
            steps: [
              {
                stage: "PLAN",
                status: "fail",
                message: "Zod rejected structured constraint JSON",
                detail: parsed.error.flatten(),
              },
            ],
          },
        });
      }
      constraint = parsed.data;
      planNotes.push("Used structured constraint JSON from client");
    } else if (typeof body.prompt === "string" && body.prompt.trim()) {
      planNotes.push("Parsing natural-language intent into JSON rules");
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
          pipeline: {
            status: "rollback",
            steps: [
              {
                stage: "PLAN",
                status: "fail",
                message:
                  "Could not map natural language to SUBSTITUTE/LOCK/SWAP rules",
                detail: { prompt: body.prompt },
              },
            ],
          },
        });
      }
      const recheck = AgentConstraintSchema.safeParse(constraint);
      if (!recheck.success) {
        return res.status(400).json({
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: recheck.error.flatten(),
          pipeline: {
            status: "rollback",
            steps: [
              {
                stage: "PLAN",
                status: "fail",
                message: "Parsed intent failed Zod re-validation",
                detail: recheck.error.flatten(),
              },
            ],
          },
        });
      }
      constraint = recheck.data;
      planNotes.push(`Mapped prompt → ${constraint.action}`);
    } else {
      return res.status(400).json({
        ok: false,
        error: "Provide either prompt or constraint",
        code: "MISSING_PROMPT",
        pipeline: {
          status: "rollback",
          steps: [
            {
              stage: "PLAN",
              status: "fail",
              message: "No prompt or constraint provided",
            },
          ],
        },
      });
    }

    const outcome = applyDynamicConstraintSafely(
      body.input,
      body.result,
      constraint
    );

    // Enrich PLAN step with API-side notes while preserving engine pipeline
    const pipeline = {
      ...outcome.pipeline,
      steps: outcome.pipeline.steps.map((step, index) =>
        index === 0 && step.stage === "PLAN"
          ? {
              ...step,
              message:
                planNotes.length > 0
                  ? `${step.message} · ${planNotes.join(" · ")}`
                  : step.message,
            }
          : step
      ),
    };

    if (!outcome.ok) {
      return res.status(422).json({
        ok: false,
        error: outcome.error,
        code: outcome.code,
        rolledBack: true,
        status: "rollback",
        pipeline,
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
      pipeline,
    });
  } catch {
    return res.status(500).json({
      ok: false,
      error: "Agent engine failed unexpectedly — schedule unchanged",
      code: "ENGINE_ERROR",
      rolledBack: true,
      status: "rollback",
      pipeline: {
        status: "rollback",
        steps: [
          {
            stage: "PLAN",
            status: "fail",
            message: "Unexpected server exception",
          },
          {
            stage: "ACT",
            status: "skip",
            message: "Skipped",
          },
          {
            stage: "CHECK",
            status: "skip",
            message: "Skipped — previous schedule preserved",
          },
        ],
      },
    });
  }
}
