import type {
  DayOfWeek,
  ScheduleAssignment,
  ScheduleInput,
  ScheduleResult,
} from "../types/schedule";
import { DAY_TO_ICAL_WEEKDAY } from "../types/schedule";

const CRLF = "\r\n";

/** Escape text per RFC 5545 §3.3.11 */
function icalEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Fold long content lines at 75 octets (RFC 5545 §3.1) */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join(CRLF);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Format as floating local `YYYYMMDDTHHMMSS` (no Z) */
function formatIcalLocal(date: Date): string {
  return (
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
  );
}

function parseHm(hm: string): { hours: number; minutes: number } {
  const [h, m] = hm.split(":").map((x) => Number.parseInt(x, 10));
  return {
    hours: Number.isFinite(h) ? h : 0,
    minutes: Number.isFinite(m) ? m : 0,
  };
}

/** Monday (local) of the week containing `ref` */
export function startOfWeekMonday(ref = new Date()): Date {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const day = d.getDay(); // 0=Sun … 6=Sat
  const offset = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + offset);
  d.setHours(0, 0, 0, 0);
  return d;
}

const DAY_OFFSET: Record<DayOfWeek, number> = {
  MON: 0,
  TUE: 1,
  WED: 2,
  THU: 3,
  FRI: 4,
};

function slotDateTime(
  weekMonday: Date,
  day: DayOfWeek,
  hm: string
): Date {
  const { hours, minutes } = parseHm(hm);
  const d = new Date(weekMonday);
  d.setDate(weekMonday.getDate() + DAY_OFFSET[day]);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function sanitizeFilenamePart(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "teacher";
}

function downloadTextFile(filename: string, content: string, mime: string) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Calendar download is only available in the browser");
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export type BuildTeacherIcalOptions = {
  teacherId: string;
  result: ScheduleResult;
  input: ScheduleInput;
  /** Anchor week (defaults to current week’s Monday) */
  weekStart?: Date;
  calendarName?: string;
  institutionName?: string;
};

/**
 * Build a valid RFC 5545 iCalendar document for one teacher’s allocated slots.
 * Events use floating local times + weekly recurrence (BYDAY).
 */
export function buildTeacherIcal(options: BuildTeacherIcalOptions): string {
  const {
    teacherId,
    result,
    input,
    weekStart = startOfWeekMonday(),
    calendarName,
    institutionName,
  } = options;

  const teacher = input.teachers.find((t) => t.id === teacherId);
  const teacherName = teacher?.name ?? teacherId;
  const subjectsById = new Map(input.subjects.map((s) => [s.id, s]));
  const roomsById = new Map(input.rooms.map((r) => [r.id, r]));
  const groupsById = new Map(input.classGroups.map((g) => [g.id, g]));

  const assignments = result.assignments.filter(
    (a) => a.teacherId === teacherId
  );

  const stamp = formatIcalLocal(new Date());
  const calName =
    calendarName?.trim() ||
    `Schedule — ${teacherName}${institutionName?.trim() ? ` · ${institutionName.trim()}` : ""}`;

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//teamBRU//AI Timetable//TH",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    foldLine(`X-WR-CALNAME:${icalEscape(calName)}`),
  ];

  for (const a of assignments) {
    lines.push(...veventLines(a, {
      stamp,
      weekMonday: weekStart,
      subjectsById,
      roomsById,
      groupsById,
      teacherName,
    }));
  }

  lines.push("END:VCALENDAR");
  return lines.join(CRLF) + CRLF;
}

function veventLines(
  a: ScheduleAssignment,
  ctx: {
    stamp: string;
    weekMonday: Date;
    subjectsById: Map<string, ScheduleInput["subjects"][number]>;
    roomsById: Map<string, ScheduleInput["rooms"][number]>;
    groupsById: Map<string, ScheduleInput["classGroups"][number]>;
    teacherName: string;
  }
): string[] {
  const subject = ctx.subjectsById.get(a.subjectId);
  const room = ctx.roomsById.get(a.roomId);
  const group = ctx.groupsById.get(a.classGroupId);
  const summary = subject
    ? `${subject.code} · ${subject.name}`
    : a.subjectId;
  const location = room?.name ?? a.roomId;
  const description = [
    group ? `Group: ${group.groupName}` : null,
    `Teacher: ${ctx.teacherName}`,
    subject ? `Subject: ${subject.code}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const dtStart = slotDateTime(
    ctx.weekMonday,
    a.timeSlot.day,
    a.timeSlot.startTime
  );
  const dtEnd = slotDateTime(
    ctx.weekMonday,
    a.timeSlot.day,
    a.timeSlot.endTime
  );
  const byday = DAY_TO_ICAL_WEEKDAY[a.timeSlot.day];
  const uid = `${a.id}@teambru-timetable`;

  return [
    "BEGIN:VEVENT",
    foldLine(`UID:${icalEscape(uid)}`),
    `DTSTAMP:${ctx.stamp}`,
    `DTSTART:${formatIcalLocal(dtStart)}`,
    `DTEND:${formatIcalLocal(dtEnd)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=${byday}`,
    foldLine(`SUMMARY:${icalEscape(summary)}`),
    foldLine(`LOCATION:${icalEscape(location)}`),
    foldLine(`DESCRIPTION:${icalEscape(description)}`),
    "END:VEVENT",
  ];
}

export function downloadTeacherIcal(
  options: BuildTeacherIcalOptions & { teacherName?: string }
): void {
  const teacher =
    options.input.teachers.find((t) => t.id === options.teacherId)?.name ??
    options.teacherName ??
    options.teacherId;
  const content = buildTeacherIcal(options);
  const filename = `schedule-${sanitizeFilenamePart(teacher)}.ics`;
  downloadTextFile(filename, content, "text/calendar;charset=utf-8");
}
