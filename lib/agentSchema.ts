import { z } from "zod";

export const AgentConstraintSchema = z.object({
  action: z.enum(["SUBSTITUTE_TEACHER", "LOCK_SLOT", "SWAP_PERIOD"]),
  targetTeacherId: z.string().min(1),
  day: z.enum(["MON", "TUE", "WED", "THU", "FRI"]),
  period: z.coerce.number().int().min(1).max(12),
  reason: z.string().min(1),
});

export type AgentConstraint = z.infer<typeof AgentConstraintSchema>;

const DAY_ALIASES: Array<{ day: AgentConstraint["day"]; patterns: RegExp[] }> = [
  { day: "MON", patterns: [/\bmon(?:day)?\b/i, /จันทร์/] },
  { day: "TUE", patterns: [/\btue(?:s(?:day)?)?\b/i, /อังคาร/] },
  { day: "WED", patterns: [/\bwed(?:nesday)?\b/i, /พุธ/] },
  { day: "THU", patterns: [/\bthu(?:r(?:s(?:day)?)?)?\b/i, /พฤหัส/] },
  { day: "FRI", patterns: [/\bfri(?:day)?\b/i, /ศุกร์/] },
];

/**
 * Deterministic offline NL → constraint parser (Thai/EN keywords).
 * Returns null when the prompt cannot be mapped confidently.
 */
export function parseAgentPrompt(
  prompt: string,
  teacherHints: Array<{ id: string; name: string }> = []
): AgentConstraint | null {
  const text = prompt.trim();
  if (!text) return null;

  let action: AgentConstraint["action"] | null = null;
  if (
    /ลากิจ|ลาป่วย|substitute|หาครู.?มาสอนแทน|สอนแทน/i.test(text)
  ) {
    action = "SUBSTITUTE_TEACHER";
  } else if (/ล็อค|lock\s*slot|ห้ามย้าย|ตรึงคาบ/i.test(text)) {
    action = "LOCK_SLOT";
  } else if (/สลับ|swap/i.test(text)) {
    action = "SWAP_PERIOD";
  }
  if (!action) return null;

  const periodMatch =
    text.match(/คาบ\s*(\d{1,2})/i) ||
    text.match(/\bperiod\s*(\d{1,2})\b/i) ||
    text.match(/\bP\s*(\d{1,2})\b/i);
  const period = periodMatch ? Number.parseInt(periodMatch[1]!, 10) : NaN;
  if (!Number.isFinite(period)) return null;

  let day: AgentConstraint["day"] | null = null;
  for (const entry of DAY_ALIASES) {
    if (entry.patterns.some((re) => re.test(text))) {
      day = entry.day;
      break;
    }
  }
  if (!day) day = "MON";

  let targetTeacherId = "";
  const sorted = [...teacherHints].sort(
    (a, b) => b.name.length - a.name.length
  );
  for (const teacher of sorted) {
    if (
      teacher.name &&
      text.toLowerCase().includes(teacher.name.toLowerCase())
    ) {
      targetTeacherId = teacher.id;
      break;
    }
  }
  if (!targetTeacherId) {
    const idMatch = text.match(/\b(T\d+|teacher[-_]?\w+)\b/i);
    if (idMatch) targetTeacherId = idMatch[1]!;
  }
  if (!targetTeacherId && sorted[0]) targetTeacherId = sorted[0].id;
  if (!targetTeacherId) return null;

  const parsed = AgentConstraintSchema.safeParse({
    action,
    targetTeacherId,
    day,
    period,
    reason: text,
  });
  return parsed.success ? parsed.data : null;
}
