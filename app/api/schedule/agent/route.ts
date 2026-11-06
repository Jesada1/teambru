import {
  AgentConstraintSchema,
  parseAgentPrompt,
  type AgentConstraint,
} from "../../../../lib/agentSchema";
import { applyDynamicConstraintSafely } from "../../../../lib/csp-engine";
import type { ScheduleInput, ScheduleResult } from "../../../../types/schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AgentRequestBody = {
  prompt?: string;
  constraint?: unknown;
  input?: ScheduleInput;
  result?: ScheduleResult;
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * POST /api/schedule/agent
 * Parses NL prompt (or accepts a prebuilt constraint), validates with Zod,
 * then applies a sandboxed CSP draft mutation with rollback on failure.
 */
export async function POST(request: Request) {
  let body: AgentRequestBody;
  try {
    body = (await request.json()) as AgentRequestBody;
  } catch {
    return json(
      { ok: false, error: "Invalid JSON body", code: "INVALID_JSON" },
      400
    );
  }

  if (!body.input || !body.result) {
    return json(
      {
        ok: false,
        error: "Missing schedule input/result payload",
        code: "MISSING_SCHEDULE",
      },
      400
    );
  }

  let constraint: AgentConstraint | null = null;

  if (body.constraint != null) {
    const parsed = AgentConstraintSchema.safeParse(body.constraint);
    if (!parsed.success) {
      return json(
        {
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: parsed.error.flatten(),
        },
        400
      );
    }
    constraint = parsed.data;
  } else if (typeof body.prompt === "string" && body.prompt.trim()) {
    constraint = parseAgentPrompt(
      body.prompt,
      body.input.teachers.map((t) => ({ id: t.id, name: t.name }))
    );
    if (!constraint) {
      return json(
        {
          ok: false,
          error:
            "ไม่สามารถตีความคำสั่งได้ กรุณาระบุครู วัน และคาบให้ชัดเจน",
          code: "PARSE_FAILED",
        },
        400
      );
    }
    const recheck = AgentConstraintSchema.safeParse(constraint);
    if (!recheck.success) {
      return json(
        {
          ok: false,
          error: "Constraint validation failed",
          code: "ZOD_VALIDATION",
          details: recheck.error.flatten(),
        },
        400
      );
    }
    constraint = recheck.data;
  } else {
    return json(
      {
        ok: false,
        error: "Provide either prompt or constraint",
        code: "MISSING_PROMPT",
      },
      400
    );
  }

  // CSP engine only runs after successful Zod validation
  try {
    const outcome = applyDynamicConstraintSafely(
      body.input,
      body.result,
      constraint
    );

    if (!outcome.ok) {
      return json(
        {
          ok: false,
          error: outcome.error,
          code: outcome.code,
          rolledBack: true,
          status: "rollback",
        },
        422
      );
    }

    return json({
      ok: true,
      status: "applied",
      message: outcome.message,
      appliedAction: outcome.appliedAction,
      constraint,
      result: outcome.result,
      hardConflictCount: outcome.result.hardConflictCount,
    });
  } catch {
    return json(
      {
        ok: false,
        error: "Agent engine failed unexpectedly — schedule unchanged",
        code: "ENGINE_ERROR",
        rolledBack: true,
        status: "rollback",
      },
      500
    );
  }
}
