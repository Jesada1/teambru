"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowLeftRight,
  Bot,
  CalendarPlus,
  CalendarX,
  CheckCircle2,
  Coffee,
  FileSpreadsheet,
  Info,
  MapPin,
  Printer,
  Redo2,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  User,
  Users,
  X,
} from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { useToast } from "../context/ToastContext";
import {
  checkHardConstraints,
  recomputeScheduleMetrics,
} from "../engine/solver";
import { downloadTeacherIcal } from "../lib/exportIcal";
import type { ExportMeta } from "../lib/exportSchedule";
import type {
  ClassGroup,
  ConstraintCode,
  DayOfWeek,
  Room,
  RoomType,
  ScheduleAssignment,
  ScheduleInput,
  ScheduleResult,
  Subject,
  Teacher,
  TimeSlot,
} from "../types/schedule";
import type { TranslationKey } from "../lib/i18n";

const HISTORY_LIMIT = 40;

export type ScheduleViewMode = "teacher" | "room" | "classGroup";

export type ScheduleDashboardProps = {
  result: ScheduleResult;
  input: ScheduleInput;
  onExportPdf?: (meta: ExportMeta) => void;
  onExportExcel?: (meta: ExportMeta) => void | Promise<void>;
  onReset?: () => void;
  onResultChange?: (result: ScheduleResult) => void;
};

const DAYS: DayOfWeek[] = ["MON", "TUE", "WED", "THU", "FRI"];

const DAY_KEYS: Record<DayOfWeek, TranslationKey> = {
  MON: "dash.day.MON",
  TUE: "dash.day.TUE",
  WED: "dash.day.WED",
  THU: "dash.day.THU",
  FRI: "dash.day.FRI",
};

const DAY_SHORT_KEYS: Record<DayOfWeek, TranslationKey> = {
  MON: "dash.dayShort.MON",
  TUE: "dash.dayShort.TUE",
  WED: "dash.dayShort.WED",
  THU: "dash.dayShort.THU",
  FRI: "dash.dayShort.FRI",
};

const ROOM_TYPE_STYLE: Record<RoomType, string> = {
  THEORY: "border-zinc-300 bg-zinc-100 text-zinc-700",
  LAB: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800",
  SPECIFIC: "border-violet-500/30 bg-violet-500/10 text-violet-800",
};

/** Card surface by subject/room type — theory = slate, lab = emerald */
const SLOT_TYPE_STYLE: Record<RoomType, string> = {
  THEORY:
    "border-zinc-300/90 bg-zinc-50 text-zinc-900 shadow-[inset_3px_0_0_0_rgb(113_113_122)]",
  LAB: "border-emerald-500/40 bg-emerald-950/20 text-emerald-50 shadow-[inset_3px_0_0_0_rgb(16_185_129)]",
  SPECIFIC:
    "border-violet-400/40 bg-violet-950/15 text-violet-50 shadow-[inset_3px_0_0_0_rgb(167_139_250)]",
};

type EntityOption = { id: string; label: string };

type DetailSelection = {
  assignment: ScheduleAssignment;
};

type MergedSlotBlock = {
  day: DayOfWeek;
  startPeriod: number;
  span: number;
  assignment: ScheduleAssignment;
  memberIds: string[];
};

function uniquePeriods(timeSlots: TimeSlot[]): number[] {
  return [...new Set(timeSlots.map((s) => s.period))].sort((a, b) => a - b);
}

function periodMeta(timeSlots: TimeSlot[], period: number) {
  const slot = timeSlots.find((s) => s.period === period);
  return {
    title: `P${period}`,
    range: slot ? `${slot.startTime}–${slot.endTime}` : "",
  };
}

function assignmentKey(a: ScheduleAssignment): string {
  return `${a.timeSlot.day}|${a.timeSlot.period}`;
}

function toMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((x) => Number.parseInt(x, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return -1;
  return h * 60 + m;
}

/** Fixed lunch/break: Periods 4–5, or any slot overlapping 12:00–13:00 */
function isBreakPeriod(timeSlots: TimeSlot[], period: number): boolean {
  if (period === 4 || period === 5) return true;
  const slot = timeSlots.find((s) => s.period === period);
  if (!slot) return false;
  const start = toMinutes(slot.startTime);
  const end = toMinutes(slot.endTime);
  if (start < 0 || end < 0) return false;
  const lunchStart = 12 * 60;
  const lunchEnd = 13 * 60;
  return start < lunchEnd && end > lunchStart;
}

type TimetableDisplayRow =
  | { type: "period"; period: number; rowIndex: number }
  | {
      type: "break";
      periods: number[];
      rowIndex: number;
      startTime: string;
      endTime: string;
    };

/** Collapse consecutive break periods (e.g. P4+P5) into one display row */
function buildDisplayRows(
  periods: number[],
  timeSlots: TimeSlot[]
): TimetableDisplayRow[] {
  const rows: TimetableDisplayRow[] = [];
  let rowIndex = 0;
  let i = 0;
  while (i < periods.length) {
    const period = periods[i]!;
    if (isBreakPeriod(timeSlots, period)) {
      const run: number[] = [period];
      while (
        i + 1 < periods.length &&
        isBreakPeriod(timeSlots, periods[i + 1]!)
      ) {
        i += 1;
        run.push(periods[i]!);
      }
      const first = timeSlots.find((s) => s.period === run[0]);
      const last = timeSlots.find((s) => s.period === run[run.length - 1]);
      rows.push({
        type: "break",
        periods: run,
        rowIndex,
        startTime: first?.startTime ?? "",
        endTime: last?.endTime ?? "",
      });
      rowIndex += 1;
    } else {
      rows.push({ type: "period", period, rowIndex });
      rowIndex += 1;
    }
    i += 1;
  }
  return rows;
}

function sameLessonBlock(a: ScheduleAssignment, b: ScheduleAssignment): boolean {
  return (
    a.subjectId === b.subjectId &&
    a.teacherId === b.teacherId &&
    a.roomId === b.roomId &&
    a.classGroupId === b.classGroupId
  );
}

/**
 * Merge contiguous same-lesson periods on a day into rowspan blocks.
 * Break periods interrupt merging.
 */
function buildMergedBlocks(
  assignments: ScheduleAssignment[],
  periods: number[],
  timeSlots: TimeSlot[]
): {
  blocksByStart: Map<string, MergedSlotBlock>;
  coveredKeys: Set<string>;
} {
  const byDayPeriod = new Map<string, ScheduleAssignment[]>();
  for (const a of assignments) {
    const key = assignmentKey(a);
    const list = byDayPeriod.get(key) ?? [];
    list.push(a);
    byDayPeriod.set(key, list);
  }

  const blocksByStart = new Map<string, MergedSlotBlock>();
  const coveredKeys = new Set<string>();
  const consumed = new Set<string>();

  for (const day of DAYS) {
    for (let i = 0; i < periods.length; i++) {
      const period = periods[i]!;
      const startKey = `${day}|${period}`;
      if (consumed.has(startKey) || isBreakPeriod(timeSlots, period)) continue;

      const cells = byDayPeriod.get(startKey) ?? [];
      if (cells.length !== 1) continue;
      const head = cells[0]!;

      let span = 1;
      const memberIds = [head.id];
      for (let j = i + 1; j < periods.length; j++) {
        const nextPeriod = periods[j]!;
        if (nextPeriod !== period + (j - i)) break;
        if (isBreakPeriod(timeSlots, nextPeriod)) break;
        const nextKey = `${day}|${nextPeriod}`;
        const nextCells = byDayPeriod.get(nextKey) ?? [];
        if (nextCells.length !== 1) break;
        const next = nextCells[0]!;
        if (!sameLessonBlock(head, next)) break;
        span += 1;
        memberIds.push(next.id);
        consumed.add(nextKey);
        coveredKeys.add(nextKey);
      }

      if (span > 1) {
        for (let k = 1; k < span; k++) {
          coveredKeys.add(`${day}|${period + k}`);
        }
      }

      blocksByStart.set(startKey, {
        day,
        startPeriod: period,
        span,
        assignment: head,
        memberIds,
      });
      consumed.add(startKey);
    }
  }

  return { blocksByStart, coveredKeys };
}

function speedTone(ms: number): "fast" | "ok" | "slow" {
  if (ms < 500) return "fast";
  if (ms <= 2000) return "ok";
  return "slow";
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        className="inline-flex items-center justify-center rounded-md p-0.5 transition-colors"
        aria-label="info"
      >
        <Info className="h-4 w-4 text-zinc-400 transition-colors hover:text-zinc-600" />
      </button>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1 hidden w-56 -translate-x-1/2 rounded-md border border-zinc-200/80 bg-white px-2.5 py-2 text-left text-[11px] font-medium leading-relaxed text-zinc-600 group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

const CONFLICT_KEYS: Partial<Record<ConstraintCode, TranslationKey>> = {
  H1: "dash.conflict.H1",
  H2: "dash.conflict.H2",
  H3: "dash.conflict.H3",
  H4: "dash.conflict.H4",
  H5: "dash.conflict.H5",
};

export function ScheduleDashboard({
  result,
  input,
  onExportPdf,
  onExportExcel,
  onReset,
  onResultChange,
}: ScheduleDashboardProps) {
  const { t } = useLanguage();
  const { pushToast } = useToast();
  const [workingResult, setWorkingResult] = useState(result);
  const [past, setPast] = useState<ScheduleResult[]>([]);
  const [future, setFuture] = useState<ScheduleResult[]>([]);
  const skipResultSyncRef = useRef(false);
  const workingRef = useRef(workingResult);
  workingRef.current = workingResult;
  const [institutionName, setInstitutionName] = useState("");
  const [semesterLabel, setSemesterLabel] = useState("");
  const [view, setView] = useState<ScheduleViewMode>("teacher");
  const [selectedEntityId, setSelectedEntityId] = useState("");
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<DetailSelection | null>(null);
  const [swapSourceId, setSwapSourceId] = useState<string | null>(null);
  const [invalidTargetKey, setInvalidTargetKey] = useState<string | null>(null);
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const [mobileDay, setMobileDay] = useState<DayOfWeek>("MON");
  const [isMobile, setIsMobile] = useState(false);
  const [exportSheetOpen, setExportSheetOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentStatus, setAgentStatus] = useState<
    "idle" | "applied" | "rollback" | "zero"
  >("idle");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const visibleDays = isMobile ? [mobileDay] : DAYS;

  useEffect(() => {
    if (skipResultSyncRef.current) {
      skipResultSyncRef.current = false;
      return;
    }
    setWorkingResult(result);
    setPast([]);
    setFuture([]);
    setSwapSourceId(null);
    setInvalidTargetKey(null);
    setInvalidReason(null);
  }, [result]);

  const exportMeta: ExportMeta = useMemo(
    () => ({
      institutionName: institutionName.trim() || undefined,
      semesterLabel: semesterLabel.trim() || undefined,
    }),
    [institutionName, semesterLabel]
  );

  const subjectsById = useMemo(
    () => new Map(input.subjects.map((s) => [s.id, s])),
    [input.subjects]
  );
  const teachersById = useMemo(
    () => new Map(input.teachers.map((teacher) => [teacher.id, teacher])),
    [input.teachers]
  );
  const roomsById = useMemo(
    () => new Map(input.rooms.map((room) => [room.id, room])),
    [input.rooms]
  );
  const groupsById = useMemo(
    () => new Map(input.classGroups.map((g) => [g.id, g])),
    [input.classGroups]
  );

  const entityOptions = useMemo<EntityOption[]>(() => {
    const q = query.trim().toLowerCase();
    const match = (label: string) => !q || label.toLowerCase().includes(q);

    if (view === "teacher") {
      return input.teachers
        .filter((teacher) => match(teacher.name) || match(teacher.id))
        .map((teacher) => ({ id: teacher.id, label: teacher.name }));
    }
    if (view === "room") {
      return input.rooms
        .filter((room) => match(room.name) || match(room.id))
        .map((room) => ({ id: room.id, label: room.name }));
    }
    return input.classGroups
      .filter(
        (g) => match(g.groupName) || match(g.id) || match(g.department)
      )
      .map((g) => ({ id: g.id, label: g.groupName }));
  }, [view, input, query]);

  const activeEntityId =
    selectedEntityId && entityOptions.some((e) => e.id === selectedEntityId)
      ? selectedEntityId
      : entityOptions[0]?.id ?? "";

  const filteredAssignments = useMemo(() => {
    if (!activeEntityId) return [];
    return workingResult.assignments.filter((a) => {
      if (view === "teacher") return a.teacherId === activeEntityId;
      if (view === "room") return a.roomId === activeEntityId;
      return a.classGroupId === activeEntityId;
    });
  }, [workingResult.assignments, view, activeEntityId]);

  const cellMap = useMemo(() => {
    const map = new Map<string, ScheduleAssignment[]>();
    for (const a of filteredAssignments) {
      const key = assignmentKey(a);
      const list = map.get(key) ?? [];
      list.push(a);
      map.set(key, list);
    }
    return map;
  }, [filteredAssignments]);

  const periods = useMemo(
    () => uniquePeriods(input.timeSlots),
    [input.timeSlots]
  );

  const { blocksByStart, coveredKeys } = useMemo(
    () =>
      buildMergedBlocks(filteredAssignments, periods, input.timeSlots),
    [filteredAssignments, periods, input.timeSlots]
  );

  const displayRows = useMemo(
    () => buildDisplayRows(periods, input.timeSlots),
    [periods, input.timeSlots]
  );

  const gridColsClass =
    visibleDays.length === 1
      ? "grid-cols-[90px_1fr]"
      : visibleDays.length === 5
        ? "grid-cols-[90px_repeat(5,1fr)]"
        : `grid-cols-[90px_repeat(${visibleDays.length},1fr)]`;

  const tabs: Array<{ id: ScheduleViewMode; labelKey: TranslationKey }> = [
    { id: "teacher", labelKey: "dash.tab.teacher" },
    { id: "room", labelKey: "dash.tab.room" },
    { id: "classGroup", labelKey: "dash.tab.classGroup" },
  ];

  const tone = speedTone(workingResult.executionTimeMs);
  const speedLabel =
    tone === "fast"
      ? t("dash.speed.fast")
      : tone === "ok"
        ? t("dash.speed.ok")
        : t("dash.speed.slow");

  const utilization = Math.min(
    100,
    Math.max(0, workingResult.roomUtilizationPercent)
  );
  const balance = Math.min(1, Math.max(0, workingResult.teacherWorkloadBalance));
  const hardConflicts = workingResult.hardConflictCount;
  const conflictOk = hardConflicts === 0;
  const activeEntityLabel =
    entityOptions.find((e) => e.id === activeEntityId)?.label ?? "—";
  const hasFilter = query.trim().length > 0 || selectedEntityId !== "";
  const swapSource = swapSourceId
    ? workingResult.assignments.find((a) => a.id === swapSourceId)
    : undefined;

  const clearFilter = () => {
    setQuery("");
    setSelectedEntityId("");
  };

  const filterToTeacher = (teacherId: string) => {
    setView("teacher");
    setSelectedEntityId(teacherId);
    setQuery("");
    setDetail(null);
  };

  const filterToRoom = (roomId: string) => {
    setView("room");
    setSelectedEntityId(roomId);
    setQuery("");
    setDetail(null);
  };

  const conflictReason = (code?: ConstraintCode) => {
    if (code && CONFLICT_KEYS[code]) return t(CONFLICT_KEYS[code]!);
    return t("dash.conflict.generic");
  };

  const publishResult = useCallback(
    (next: ScheduleResult) => {
      skipResultSyncRef.current = true;
      setWorkingResult(next);
      onResultChange?.(next);
    },
    [onResultChange]
  );

  const commitAssignments = (nextAssignments: ScheduleAssignment[]) => {
    const next = recomputeScheduleMetrics(
      input,
      nextAssignments,
      workingResult.seed,
      workingResult.executionTimeMs
    );
    setPast((p) => [...p, workingRef.current].slice(-HISTORY_LIMIT));
    setFuture([]);
    workingRef.current = next;
    publishResult(next);
    return next;
  };

  const undo = useCallback(() => {
    setPast((prevPast) => {
      if (prevPast.length === 0) return prevPast;
      const previous = prevPast[prevPast.length - 1]!;
      const current = workingRef.current;
      setFuture((f) => [current, ...f].slice(0, HISTORY_LIMIT));
      workingRef.current = previous;
      publishResult(previous);
      setSwapSourceId(null);
      setInvalidTargetKey(null);
      setInvalidReason(null);
      pushToast(t("dash.undoOk"), "success");
      return prevPast.slice(0, -1);
    });
  }, [publishResult, pushToast, t]);

  const redo = useCallback(() => {
    setFuture((prevFuture) => {
      if (prevFuture.length === 0) return prevFuture;
      const next = prevFuture[0]!;
      const current = workingRef.current;
      setPast((p) => [...p, current].slice(-HISTORY_LIMIT));
      workingRef.current = next;
      publishResult(next);
      setSwapSourceId(null);
      setInvalidTargetKey(null);
      setInvalidReason(null);
      pushToast(t("dash.redoOk"), "success");
      return prevFuture.slice(1);
    });
  }, [publishResult, pushToast, t]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  const attemptSwap = (sourceId: string, targetId: string) => {
    const source = workingResult.assignments.find((a) => a.id === sourceId);
    const target = workingResult.assignments.find((a) => a.id === targetId);
    if (!source || !target) return;

    const nextAssignments = workingResult.assignments.map((a) => {
      if (a.id === source.id) return { ...a, timeSlot: { ...target.timeSlot } };
      if (a.id === target.id) return { ...a, timeSlot: { ...source.timeSlot } };
      return a;
    });

    const check = checkHardConstraints(input, nextAssignments);
    const targetKey = `${target.timeSlot.day}|${target.timeSlot.period}`;
    if (!check.ok) {
      setInvalidTargetKey(targetKey);
      setInvalidReason(
        conflictReason(check.conflicts[0]?.code)
      );
      pushToast(
        t("dash.swap.invalid", {
          reason: conflictReason(check.conflicts[0]?.code),
        }),
        "error"
      );
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          setInvalidTargetKey(null);
          setInvalidReason(null);
        }, 3200);
      }
      return;
    }

    commitAssignments(nextAssignments);
    setSwapSourceId(null);
    setInvalidTargetKey(null);
    setInvalidReason(null);
    pushToast(t("dash.swap.success"), "success");
  };

  const attemptMove = (sourceId: string, day: DayOfWeek, period: number) => {
    const source = workingResult.assignments.find((a) => a.id === sourceId);
    const slot = input.timeSlots.find(
      (s) => s.day === day && s.period === period
    );
    if (!source || !slot) return;

    const nextAssignments = workingResult.assignments.map((a) =>
      a.id === source.id ? { ...a, timeSlot: { ...slot } } : a
    );

    const check = checkHardConstraints(input, nextAssignments);
    const targetKey = `${day}|${period}`;
    if (!check.ok) {
      setInvalidTargetKey(targetKey);
      setInvalidReason(conflictReason(check.conflicts[0]?.code));
      pushToast(
        t("dash.swap.invalid", {
          reason: conflictReason(check.conflicts[0]?.code),
        }),
        "error"
      );
      if (typeof window !== "undefined") {
        window.setTimeout(() => {
          setInvalidTargetKey(null);
          setInvalidReason(null);
        }, 3200);
      }
      return;
    }

    commitAssignments(nextAssignments);
    setSwapSourceId(null);
    setInvalidTargetKey(null);
    setInvalidReason(null);
    pushToast(t("dash.swap.moveSuccess"), "success");
  };

  const onSlotCardClick = (assignment: ScheduleAssignment) => {
    if (!swapSourceId) {
      setSwapSourceId(assignment.id);
      setInvalidTargetKey(null);
      setInvalidReason(null);
      return;
    }
    if (swapSourceId === assignment.id) {
      setDetail({ assignment });
      setSwapSourceId(null);
      return;
    }
    attemptSwap(swapSourceId, assignment.id);
  };

  const onEmptyCellClick = (day: DayOfWeek, period: number) => {
    if (!swapSourceId) return;
    attemptMove(swapSourceId, day, period);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDetail(null);
        setSwapSourceId(null);
        setInvalidTargetKey(null);
        setInvalidReason(null);
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (past.length > 0) undo();
        return;
      }
      if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        if (future.length > 0) redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, past.length, future.length]);

  const runAgent = useCallback(
    async (promptOverride?: string) => {
      const prompt = (promptOverride ?? agentPrompt).trim();
      if (!prompt || agentBusy) return;
      setAgentBusy(true);
      try {
        const res = await fetch("/api/schedule/agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            input,
            result: workingResult,
          }),
        });
        const data = (await res.json()) as {
          ok?: boolean;
          error?: string;
          message?: string;
          status?: string;
          result?: ScheduleResult;
          hardConflictCount?: number;
        };

        if (!res.ok || !data.ok || !data.result) {
          setAgentStatus("rollback");
          pushToast(data.error || t("dash.agent.fail"), "error");
          return;
        }

        setPast((p) => [...p, workingRef.current].slice(-HISTORY_LIMIT));
        setFuture([]);
        workingRef.current = data.result;
        publishResult(data.result);
        setAgentStatus(
          data.result.hardConflictCount === 0 ? "zero" : "applied"
        );
        pushToast(data.message || t("dash.agent.applied"), "success");
        if (promptOverride) setAgentPrompt(promptOverride);
      } catch {
        setAgentStatus("rollback");
        pushToast(t("dash.agent.fail"), "error");
      } finally {
        setAgentBusy(false);
      }
    },
    [
      agentPrompt,
      agentBusy,
      input,
      workingResult,
      publishResult,
      pushToast,
      t,
    ]
  );

  const handleExportIcs = () => {
    if (view !== "teacher" || !activeEntityId) return;
    const teacherAssignments = workingResult.assignments.filter(
      (a) => a.teacherId === activeEntityId
    );
    if (teacherAssignments.length === 0) {
      pushToast(t("dash.exportIcsEmpty"), "error");
      return;
    }
    downloadTeacherIcal({
      teacherId: activeEntityId,
      result: workingResult,
      input,
      institutionName: institutionName.trim() || undefined,
      calendarName: `${activeEntityLabel}${semesterLabel.trim() ? ` · ${semesterLabel.trim()}` : ""}`,
    });
    pushToast(t("dash.exportIcsOk"), "success");
  };

  const detailSubject = detail
    ? subjectsById.get(detail.assignment.subjectId)
    : undefined;
  const detailTeacher = detail
    ? teachersById.get(detail.assignment.teacherId)
    : undefined;
  const detailRoom = detail
    ? roomsById.get(detail.assignment.roomId)
    : undefined;
  const detailGroup = detail
    ? groupsById.get(detail.assignment.classGroupId)
    : undefined;

  const handleExportExcel = () => {
    onExportExcel?.(exportMeta);
  };

  const handleExportPdf = () => {
    if (onExportPdf) {
      onExportPdf(exportMeta);
      return;
    }
    if (typeof window !== "undefined" && typeof window.print === "function") {
      window.print();
      pushToast(t("toast.exportOk"), "success");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-3 p-3 pb-28 sm:p-5 md:pb-5">
      <div className="print-institution-header">
        {institutionName.trim() ? (
          <span className="print-institution-name">{institutionName.trim()}</span>
        ) : null}
        {semesterLabel.trim() ? (
          <span className="print-semester-label">{semesterLabel.trim()}</span>
        ) : null}
      </div>

      <header className="flex flex-col gap-3 border-b border-zinc-200/80 pb-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {t("dash.eyebrow", { seed: workingResult.seed })}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900">
            {t("dash.title")}
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-zinc-600">
            {t("dash.meta", {
              count: workingResult.assignments.length,
              soft: workingResult.softPenaltyTotal.toFixed(2),
              fitness: Number.isFinite(workingResult.fitnessScore)
                ? workingResult.fitnessScore.toFixed(2)
                : "n/a",
            })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={
              conflictOk
                ? "inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700"
                : "inline-flex items-center rounded-md border border-rose-500/20 bg-rose-500/10 px-2.5 py-1 text-xs font-semibold text-rose-700"
            }
          >
            {conflictOk ? (
              <CheckCircle2 className="mr-1.5 h-4 w-4 shrink-0 text-emerald-500" />
            ) : (
              <span className="mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500" />
            )}
            {conflictOk
              ? t("dash.zeroConflicts")
              : t("dash.hardConflicts", { count: hardConflicts })}
          </span>
          <button
            type="button"
            onClick={onReset}
            disabled={!onReset}
            className="no-print inline-flex items-center rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-zinc-600 transition-all duration-150 hover:border-zinc-200 hover:bg-zinc-100 hover:text-zinc-900 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="mr-2 h-4 w-4 shrink-0" />
            {t("dash.reset")}
          </button>
        </div>
        </div>

        <div className="no-print hidden gap-2 md:grid md:grid-cols-2">
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("dash.institution")}
            </span>
            <input
              type="text"
              value={institutionName}
              onChange={(e) => setInstitutionName(e.target.value)}
              placeholder={t("dash.institutionPlaceholder")}
              className="mt-1 w-full rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
            />
          </label>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("dash.semester")}
            </span>
            <input
              type="text"
              value={semesterLabel}
              onChange={(e) => setSemesterLabel(e.target.value)}
              placeholder={t("dash.semesterPlaceholder")}
              className="mt-1 w-full rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
            />
          </label>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2 rounded-md border border-zinc-200/80 bg-zinc-50 px-3 py-2">
          <ArrowLeftRight className="h-4 w-4 shrink-0 text-emerald-600" />
          <p className="flex-1 text-xs leading-relaxed text-zinc-600">
            {swapSource
              ? t("dash.swap.selected", {
                  code:
                    subjectsById.get(swapSource.subjectId)?.code ??
                    swapSource.subjectId,
                })
              : t("dash.swap.hint")}
          </p>
          {swapSourceId ? (
            <button
              type="button"
              onClick={() => setSwapSourceId(null)}
              className="inline-flex items-center rounded-md border border-zinc-200/80 bg-white px-2 py-1 text-xs font-medium text-zinc-600 transition-all hover:bg-zinc-100 active:scale-[0.98]"
            >
              <X className="mr-1 h-3.5 w-3.5 shrink-0" />
              {t("dash.swap.cancel")}
            </button>
          ) : null}
        </div>

        {invalidReason ? (
          <p className="no-print rounded-md border border-rose-500/25 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-700">
            {invalidReason}
          </p>
        ) : null}

        {/* Natural-language AI Agent bar */}
        <div className="no-print rounded-lg border border-zinc-200/80 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Bot className="h-4 w-4 shrink-0 text-emerald-600" />
              <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {t("dash.agent.title")}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={
                  workingResult.hardConflictCount === 0
                    ? "inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                    : "inline-flex items-center rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
                }
              >
                <CheckCircle2 className="mr-1 h-3.5 w-3.5 shrink-0" />
                {workingResult.hardConflictCount === 0
                  ? t("dash.agent.zero")
                  : t("dash.hardConflicts", {
                      count: workingResult.hardConflictCount,
                    })}
              </span>
              {agentStatus === "applied" || agentStatus === "zero" ? (
                <span className="inline-flex items-center rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                  <Sparkles className="mr-1 h-3.5 w-3.5 shrink-0" />
                  {t("dash.agent.applied")}
                </span>
              ) : null}
              {agentStatus === "rollback" ? (
                <span className="inline-flex items-center rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-800">
                  {t("dash.agent.rollback")}
                </span>
              ) : null}
            </div>
          </div>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              type="text"
              value={agentPrompt}
              onChange={(e) => setAgentPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runAgent();
              }}
              placeholder={t("dash.agent.placeholder")}
              className="min-h-[44px] w-full flex-1 rounded-md border border-zinc-200/80 bg-zinc-50 px-3 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
            />
            <button
              type="button"
              disabled={agentBusy || !agentPrompt.trim()}
              onClick={() => void runAgent()}
              className="inline-flex min-h-[44px] items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Sparkles className="mr-2 h-4 w-4 shrink-0" />
              {agentBusy ? t("dash.agent.running") : t("dash.agent.run")}
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(
              [
                "dash.agent.chip.sub",
                "dash.agent.chip.swap",
                "dash.agent.chip.lock",
              ] as const
            ).map((key) => (
              <button
                key={key}
                type="button"
                disabled={agentBusy}
                onClick={() => {
                  const chip = t(key);
                  setAgentPrompt(chip);
                  void runAgent(chip);
                }}
                className="rounded-md border border-zinc-200/80 bg-zinc-50 px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 transition-transform hover:bg-zinc-100 active:scale-95 disabled:opacity-40"
              >
                {t(key)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* KPI bento */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <article className="rounded-lg border border-zinc-200/80 bg-white p-3 sm:col-span-2 lg:col-span-1">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("dash.kpi.exec")}
            </p>
            <span
              className={
                tone === "fast"
                  ? "inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700"
                  : tone === "ok"
                    ? "inline-flex items-center gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-700"
                    : "inline-flex items-center gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
              }
            >
              <span
                className={
                  tone === "fast"
                    ? "h-1.5 w-1.5 rounded-full bg-emerald-500"
                    : tone === "ok"
                      ? "h-1.5 w-1.5 rounded-full bg-amber-500"
                      : "h-1.5 w-1.5 rounded-full bg-rose-500"
                }
              />
              {speedLabel}
            </span>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-zinc-900">
            {workingResult.executionTimeMs}
            <span className="ml-1 text-sm font-semibold text-zinc-400">ms</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500">{t("dash.kpi.execHint")}</p>
        </article>

        <article className="rounded-lg border border-zinc-200/80 bg-white p-3">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("dash.kpi.util")}
            </p>
            <InfoTip text={t("dash.kpi.utilTip")} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-zinc-900">
            {utilization.toFixed(1)}
            <span className="ml-1 text-sm font-semibold text-zinc-400">%</span>
          </p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all duration-300"
              style={{ width: `${utilization}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-zinc-500">{t("dash.kpi.utilHint")}</p>
        </article>

        <article className="rounded-lg border border-zinc-200/80 bg-white p-3">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("dash.kpi.balance")}
            </p>
            <InfoTip text={t("dash.kpi.balanceTip")} />
          </div>
          <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-zinc-900">
            {balance.toFixed(2)}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            {t("dash.kpi.balanceHint")}
          </p>
          <div className="mt-3 flex gap-0.5">
            {Array.from({ length: 10 }).map((_, i) => (
              <span
                key={i}
                className={
                  i < Math.round(balance * 10)
                    ? "h-1.5 flex-1 rounded-sm bg-emerald-600"
                    : "h-1.5 flex-1 rounded-sm bg-zinc-100"
                }
              />
            ))}
          </div>
        </article>
      </section>

      {/* Toolbar */}
      <section className="no-print rounded-lg border border-zinc-200/80 bg-white p-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div
            role="tablist"
            className="inline-flex w-fit max-w-full flex-wrap rounded-md border border-zinc-200/80 bg-zinc-50 p-0.5"
          >
            {tabs.map((tab) => {
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setView(tab.id);
                    setSelectedEntityId("");
                  }}
                  className={
                    active
                      ? "rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-all duration-150 active:scale-[0.98]"
                      : "rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 transition-all duration-150 hover:text-zinc-900 active:scale-[0.98]"
                  }
                >
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2 overflow-x-auto scrollbar-thin">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              title="Ctrl+Z"
              className="inline-flex min-h-[44px] items-center rounded-md border border-zinc-200/80 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-transform duration-150 hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Undo2 className="mr-2 h-4 w-4 shrink-0" />
              {t("dash.undo")}
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              title="Ctrl+Y"
              className="inline-flex min-h-[44px] items-center rounded-md border border-zinc-200/80 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-transform duration-150 hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Redo2 className="mr-2 h-4 w-4 shrink-0" />
              {t("dash.redo")}
            </button>
            {view === "teacher" ? (
              <button
                type="button"
                onClick={handleExportIcs}
                disabled={!activeEntityId}
                className="hidden min-h-[44px] items-center rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white transition-transform duration-150 hover:bg-emerald-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 md:inline-flex"
              >
                <CalendarPlus className="mr-2 h-4 w-4 shrink-0" />
                {t("dash.exportIcs")}
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleExportExcel}
              disabled={!onExportExcel}
              className="hidden min-h-[44px] items-center rounded-md border border-zinc-200/80 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 transition-transform duration-150 hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 md:inline-flex"
            >
              <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0" />
              {t("dash.exportExcel")}
            </button>
            <button
              type="button"
              onClick={handleExportPdf}
              className="hidden min-h-[44px] items-center rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-transform duration-150 hover:bg-zinc-800 active:scale-95 md:inline-flex"
            >
              <Printer className="mr-2 h-4 w-4 shrink-0" />
              {t("dash.exportPdf")}
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-zinc-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {t("dash.legend")}
          </span>
          {(
            [
              ["THEORY", "dash.legend.theory"],
              ["LAB", "dash.legend.lab"],
              ["SPECIFIC", "dash.legend.specific"],
            ] as const
          ).map(([type, key]) => (
            <span
              key={type}
              className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold ${ROOM_TYPE_STYLE[type]}`}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
              {t(key)}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-zinc-500/50 bg-zinc-900/40 px-2 py-0.5 text-[11px] font-semibold text-zinc-200">
            <Coffee className="h-3 w-3 shrink-0" />
            {t("dash.legend.break")}
          </span>
        </div>

        <div className="mt-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_220px_auto]">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedEntityId("");
              }}
              placeholder={
                view === "teacher"
                  ? t("dash.searchTeacher")
                  : view === "room"
                    ? t("dash.searchRoom")
                    : t("dash.searchGroup")
              }
              className="w-full rounded-md border border-zinc-200/80 bg-white py-2 pl-9 pr-3 text-sm text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
            />
          </label>
          <select
            value={activeEntityId}
            onChange={(e) => setSelectedEntityId(e.target.value)}
            aria-label={t("dash.selectEntity")}
            className="w-full rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
          >
            {entityOptions.length === 0 ? (
              <option value="">{t("dash.noMatches")}</option>
            ) : (
              entityOptions.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))
            )}
          </select>
          <button
            type="button"
            onClick={clearFilter}
            disabled={!hasFilter}
            className="inline-flex items-center justify-center rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-all duration-150 hover:bg-zinc-50 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <RotateCcw className="mr-2 h-4 w-4 shrink-0" />
            {t("dash.clearFilter")}
          </button>
        </div>
      </section>

      {/* Weekly grid */}
      <section className="print-grid w-full overflow-hidden rounded-lg border border-zinc-200/80 bg-white">
        <div className="flex items-center justify-between gap-2 border-b border-zinc-200/80 px-3 py-2">
          <div>
            <h2 className="text-sm font-bold tracking-tight text-zinc-900">
              {t("dash.gridTitle")}
            </h2>
            <p className="text-xs text-zinc-500">
              {t("dash.viewing")}{" "}
              <span className="font-medium text-zinc-700">
                {activeEntityLabel}
              </span>
            </p>
          </div>
          <p className="text-xs tabular-nums text-zinc-400">
            {t("dash.slots", { count: filteredAssignments.length })}
          </p>
        </div>

        {/* Mobile day switcher */}
        <div
          className="no-print border-b border-zinc-200/80 px-3 py-2 md:hidden"
          role="tablist"
          aria-label={t("dash.mobileDayPicker")}
        >
          <div className="flex gap-1 overflow-x-auto scrollbar-thin rounded-md border border-zinc-200/80 bg-zinc-50 p-0.5">
            {DAYS.map((day) => {
              const active = mobileDay === day;
              return (
                <button
                  key={day}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMobileDay(day)}
                  className={
                    active
                      ? "min-h-[44px] flex-1 rounded-md bg-zinc-900 px-2 py-2 text-xs font-semibold text-white transition-transform active:scale-95"
                      : "min-h-[44px] flex-1 rounded-md px-2 py-2 text-xs font-semibold text-zinc-600 transition-transform hover:text-zinc-900 active:scale-95"
                  }
                >
                  <span className="sm:hidden">{t(DAY_SHORT_KEYS[day])}</span>
                  <span className="hidden sm:inline">{t(DAY_KEYS[day])}</span>
                </button>
              );
            })}
          </div>
        </div>

        {entityOptions.length === 0 ? (
          <EmptyState
            title={t("dash.emptyFilterTitle")}
            description={t("dash.emptyFilterBody")}
            actionLabel={t("dash.clearFilter")}
            onAction={clearFilter}
          />
        ) : (
          <div className="w-full overflow-x-auto scrollbar-thin">
            <div
              className={`timetable-grid w-full min-w-0 gap-px bg-zinc-200/70 ${gridColsClass}`}
              style={{
                display: "grid",
                gridAutoRows: "minmax(85px, auto)",
              }}
            >
              {/* Header */}
              <div className="sticky left-0 z-10 flex items-center border-b border-zinc-200/80 bg-zinc-50 px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                {t("dash.period")}
              </div>
              {visibleDays.map((day) => (
                <div
                  key={`h-${day}`}
                  className="flex items-center justify-center border-b border-zinc-200/80 bg-zinc-50 px-2 py-2 text-center text-xs font-semibold tracking-wider text-zinc-500"
                >
                  {t(DAY_KEYS[day])}
                </div>
              ))}

              {displayRows.map((row) => {
                const gridRow = row.rowIndex + 2;

                if (row.type === "break") {
                  const label =
                    row.periods.length > 1
                      ? `P${row.periods[0]}–P${row.periods[row.periods.length - 1]}`
                      : `P${row.periods[0]}`;
                  const range =
                    row.startTime && row.endTime
                      ? `${row.startTime}–${row.endTime}`
                      : "";
                  return (
                    <Fragment key={`break-${row.periods.join("-")}`}>
                      <div
                        className="break-slot sticky left-0 z-10 flex min-h-[56px] flex-col justify-center px-2 py-2"
                        style={{ gridRow, gridColumn: 1 }}
                      >
                        <span className="text-xs font-semibold tracking-tight text-zinc-300">
                          {label}
                        </span>
                        {range ? (
                          <span className="text-[11px] font-medium text-zinc-400">
                            {range}
                          </span>
                        ) : null}
                      </div>
                      <div
                        className="break-slot flex min-h-[56px] items-center justify-center px-3 py-2"
                        style={{
                          gridRow,
                          gridColumn: `2 / span ${visibleDays.length}`,
                        }}
                      >
                        <span className="inline-flex items-center gap-2 text-xs font-medium tracking-wide text-zinc-400">
                          <Coffee className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                          {t("dash.breakLabel")}
                          {range ? (
                            <span className="font-medium text-zinc-500">
                              {range}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    </Fragment>
                  );
                }

                const period = row.period;
                const meta = periodMeta(input.timeSlots, period);

                return (
                  <Fragment key={`period-${period}`}>
                    <div
                      className="sticky left-0 z-10 flex min-h-[85px] flex-col justify-center border-b border-zinc-200/80 bg-white px-2 py-2"
                      style={{ gridRow, gridColumn: 1 }}
                    >
                      <span className="text-xs font-bold tracking-tight text-zinc-800">
                        {meta.title}
                      </span>
                      <span className="text-[11px] font-medium text-zinc-400">
                        {meta.range}
                      </span>
                    </div>
                    {visibleDays.map((day, dayIdx) => {
                      const cellKey = `${day}|${period}`;
                      if (!isMobile && coveredKeys.has(cellKey)) return null;

                      const merged = blocksByStart.get(cellKey);
                      const cells = cellMap.get(cellKey) ?? [];
                      const isInvalidTarget = invalidTargetKey === cellKey;
                      const rowSpan =
                        !isMobile && merged && merged.span > 1
                          ? merged.span
                          : 1;
                      const useMergedCard = !isMobile && Boolean(merged);
                      const col = dayIdx + 2;

                      return (
                        <div
                          key={`${day}-${period}`}
                          className={`timetable-cell flex min-h-[85px] flex-col border-b border-r border-zinc-200/70 bg-white p-1 transition-colors hover:bg-zinc-50/90 sm:p-1.5 ${
                            isInvalidTarget
                              ? "bg-rose-500/10 ring-2 ring-inset ring-rose-500/60"
                              : ""
                          }`}
                          style={{
                            gridColumn: col,
                            gridRow:
                              rowSpan > 1
                                ? `${gridRow} / span ${rowSpan}`
                                : gridRow,
                          }}
                        >
                          {useMergedCard && merged ? (
                            <SlotCard
                              assignment={merged.assignment}
                              subject={subjectsById.get(
                                merged.assignment.subjectId
                              )}
                              teacher={teachersById.get(
                                merged.assignment.teacherId
                              )}
                              room={roomsById.get(merged.assignment.roomId)}
                              group={groupsById.get(
                                merged.assignment.classGroupId
                              )}
                              span={merged.span}
                              minHeightClass="min-h-[85px] h-full w-full"
                              isSource={
                                swapSourceId === merged.assignment.id ||
                                merged.memberIds.includes(swapSourceId ?? "")
                              }
                              isTargetCandidate={Boolean(
                                swapSourceId &&
                                  !merged.memberIds.includes(swapSourceId)
                              )}
                              isInvalid={isInvalidTarget}
                              invalidReason={invalidReason}
                              onClick={() =>
                                onSlotCardClick(merged.assignment)
                              }
                              onDoubleClick={() =>
                                setDetail({
                                  assignment: merged.assignment,
                                })
                              }
                            />
                          ) : cells.length === 0 ? (
                            <button
                              type="button"
                              disabled={!swapSourceId}
                              onClick={() => onEmptyCellClick(day, period)}
                              className={`flex h-full min-h-[85px] w-full items-center justify-center rounded-md border border-dashed transition-transform duration-150 ${
                                isInvalidTarget
                                  ? "border-rose-400 bg-rose-500/15 text-rose-700"
                                  : swapSourceId
                                    ? "border-emerald-400/50 bg-emerald-500/5 text-emerald-700 hover:border-emerald-500 hover:bg-emerald-500/10 active:scale-95"
                                    : "cursor-default border-zinc-200/80 bg-zinc-50/40 text-transparent hover:border-zinc-300"
                              }`}
                              aria-label={
                                swapSourceId
                                  ? t("dash.swap.moveHere")
                                  : undefined
                              }
                            >
                              {isInvalidTarget ? (
                                <span className="px-1 text-center text-[10px] font-semibold leading-snug">
                                  {invalidReason}
                                </span>
                              ) : swapSourceId ? (
                                <ArrowLeftRight className="h-4 w-4 shrink-0 opacity-70" />
                              ) : null}
                            </button>
                          ) : (
                            <div className="flex h-full min-h-[85px] w-full flex-col gap-1">
                              {cells.map((a) => (
                                <SlotCard
                                  key={a.id}
                                  assignment={a}
                                  subject={subjectsById.get(a.subjectId)}
                                  teacher={teachersById.get(a.teacherId)}
                                  room={roomsById.get(a.roomId)}
                                  group={groupsById.get(a.classGroupId)}
                                  span={1}
                                  minHeightClass="min-h-[85px] h-full w-full"
                                  isSource={swapSourceId === a.id}
                                  isTargetCandidate={Boolean(
                                    swapSourceId && swapSourceId !== a.id
                                  )}
                                  isInvalid={isInvalidTarget}
                                  invalidReason={invalidReason}
                                  onClick={() => onSlotCardClick(a)}
                                  onDoubleClick={() =>
                                    setDetail({ assignment: a })
                                  }
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </Fragment>
                );
              })}
            </div>
          </div>
        )}

        {entityOptions.length > 0 &&
          filteredAssignments.length === 0 &&
          periods.length > 0 && (
            <EmptyState
              title={t("dash.emptyViewTitle")}
              description={t("dash.emptyViewBody", {
                name: activeEntityLabel,
              })}
              actionLabel={t("dash.reset")}
              onAction={onReset}
            />
          )}
      </section>

      {/* Mobile sticky action bar */}
      <div className="no-print fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200/80 bg-white/95 backdrop-blur-md md:hidden pb-safe">
        <div className="mx-auto flex max-w-[1400px] gap-2 overflow-x-auto scrollbar-thin px-3 py-2">
          <button
            type="button"
            onClick={() => {
              if (swapSourceId) setSwapSourceId(null);
              else
                pushToast(t("dash.swap.hint"), "info");
            }}
            className={`inline-flex min-h-[44px] shrink-0 items-center rounded-md px-3 text-sm font-semibold transition-transform active:scale-95 ${
              swapSourceId
                ? "border border-emerald-500/40 bg-emerald-500/15 text-emerald-800"
                : "border border-zinc-200/80 bg-white text-zinc-700"
            }`}
          >
            <ArrowLeftRight className="mr-2 h-4 w-4 shrink-0" />
            {swapSourceId ? t("dash.swap.cancel") : t("dash.swap.arm")}
          </button>
          <button
            type="button"
            onClick={() => setExportSheetOpen(true)}
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-md bg-zinc-900 px-3 text-sm font-semibold text-white transition-transform active:scale-95"
          >
            <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0" />
            {t("dash.exportSheet")}
          </button>
          <button
            type="button"
            onClick={handleExportExcel}
            disabled={!onExportExcel}
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-md border border-zinc-200/80 bg-white px-3 text-sm font-medium text-zinc-700 transition-transform active:scale-95 disabled:opacity-40"
          >
            {t("dash.exportExcel")}
          </button>
        </div>
      </div>

      {/* Export settings — bottom sheet (mobile) / dialog (desktop) */}
      {exportSheetOpen ? (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center md:items-center">
          <button
            type="button"
            className="absolute inset-0 bg-zinc-900/30 backdrop-blur-[2px]"
            aria-label={t("dash.drawer.close")}
            onClick={() => setExportSheetOpen(false)}
          />
          <aside className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-zinc-200/80 bg-white pb-safe md:max-h-[90vh] md:max-w-lg md:rounded-xl md:pb-0">
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-zinc-200 md:hidden" />
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200/80 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {t("dash.mobileActions")}
                </p>
                <h3 className="mt-1 text-lg font-bold tracking-tight text-zinc-900">
                  {t("dash.exportSheet")}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setExportSheetOpen(false)}
                className="min-h-[44px] min-w-[44px] rounded-md border border-transparent text-sm font-medium text-zinc-500 transition-transform hover:bg-zinc-50 active:scale-95"
              >
                <X className="mx-auto h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto p-4">
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {t("dash.institution")}
                </span>
                <input
                  type="text"
                  value={institutionName}
                  onChange={(e) => setInstitutionName(e.target.value)}
                  placeholder={t("dash.institutionPlaceholder")}
                  className="mt-1 min-h-[44px] w-full rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
                />
              </label>
              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {t("dash.semester")}
                </span>
                <input
                  type="text"
                  value={semesterLabel}
                  onChange={(e) => setSemesterLabel(e.target.value)}
                  placeholder={t("dash.semesterPlaceholder")}
                  className="mt-1 min-h-[44px] w-full rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/15"
                />
              </label>
              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    handleExportExcel();
                    setExportSheetOpen(false);
                  }}
                  disabled={!onExportExcel}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-semibold text-white transition-transform active:scale-95 disabled:opacity-40"
                >
                  <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0" />
                  {t("dash.exportExcel")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleExportPdf();
                    setExportSheetOpen(false);
                  }}
                  className="inline-flex min-h-[48px] items-center justify-center rounded-md border border-zinc-200/80 bg-white px-4 text-sm font-semibold text-zinc-800 transition-transform active:scale-95"
                >
                  <Printer className="mr-2 h-4 w-4 shrink-0" />
                  {t("dash.exportPdf")}
                </button>
                {view === "teacher" ? (
                  <button
                    type="button"
                    onClick={() => {
                      handleExportIcs();
                      setExportSheetOpen(false);
                    }}
                    className="inline-flex min-h-[48px] items-center justify-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white transition-transform active:scale-95"
                  >
                    <CalendarPlus className="mr-2 h-4 w-4 shrink-0" />
                    {t("dash.exportIcs")}
                  </button>
                ) : null}
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {/* Details drawer — bottom sheet on mobile, side panel on desktop */}
      {detail ? (
        <div className="no-print fixed inset-0 z-50 flex items-end justify-center md:items-stretch md:justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-zinc-900/30 backdrop-blur-[2px]"
            aria-label={t("dash.drawer.close")}
            onClick={() => setDetail(null)}
          />
          <aside className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl border border-zinc-200/80 bg-white pb-safe md:h-full md:max-h-none md:max-w-md md:rounded-none md:border-l md:pb-0">
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-zinc-200 md:hidden" />
            <div className="flex items-start justify-between gap-3 border-b border-zinc-200/80 px-4 py-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {t("dash.drawer.title")}
                </p>
                <h3 className="mt-1 text-lg font-bold tracking-tight text-zinc-900">
                  {detailSubject?.name ?? detail.assignment.subjectId}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDetail(null)}
                className="min-h-[44px] min-w-[44px] rounded-md border border-transparent text-sm font-medium text-zinc-500 transition-transform hover:bg-zinc-50 active:scale-95"
              >
                <X className="mx-auto h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              <DetailRow
                label={t("dash.drawer.code")}
                value={detailSubject?.code ?? detail.assignment.subjectId}
              />
              <DetailRow
                label={t("dash.drawer.subject")}
                value={detailSubject?.name ?? "—"}
              />
              <DetailRow
                label={t("dash.drawer.teacher")}
                value={detailTeacher?.name ?? detail.assignment.teacherId}
              />
              <DetailRow
                label={t("dash.drawer.room")}
                value={`${detailRoom?.name ?? detail.assignment.roomId}${
                  detailRoom
                    ? ` · ${detailRoom.type} · ${detailRoom.capacity}`
                    : ""
                }`}
              />
              <DetailRow
                label={t("dash.drawer.group")}
                value={detailGroup?.groupName ?? detail.assignment.classGroupId}
              />
              <DetailRow
                label={t("dash.drawer.slot")}
                value={`${t(DAY_KEYS[detail.assignment.timeSlot.day])} · P${
                  detail.assignment.timeSlot.period
                } (${detail.assignment.timeSlot.startTime}–${
                  detail.assignment.timeSlot.endTime
                })`}
              />
              {detailSubject ? (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold ${ROOM_TYPE_STYLE[detailSubject.requiredRoomType]}`}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
                  {detailSubject.requiredRoomType === "THEORY"
                    ? t("dash.legend.theory")
                    : detailSubject.requiredRoomType === "LAB"
                      ? t("dash.legend.lab")
                      : t("dash.legend.specific")}
                </span>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 border-t border-zinc-200/80 p-4">
              <button
                type="button"
                onClick={() => filterToTeacher(detail.assignment.teacherId)}
                className="rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98]"
              >
                {t("dash.drawer.filterTeacher")}
              </button>
              <button
                type="button"
                onClick={() => filterToRoom(detail.assignment.roomId)}
                className="rounded-md border border-zinc-200/80 bg-white px-3 py-2 text-sm font-medium text-zinc-700 transition-all duration-150 hover:bg-zinc-50 active:scale-[0.98]"
              >
                {t("dash.drawer.filterRoom")}
              </button>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function SlotCard({
  assignment,
  subject,
  teacher,
  room,
  group,
  span,
  minHeightClass,
  isSource,
  isTargetCandidate,
  isInvalid,
  invalidReason,
  onClick,
  onDoubleClick,
}: {
  assignment: ScheduleAssignment;
  subject?: Subject;
  teacher?: Teacher;
  room?: Room;
  group?: ClassGroup;
  span: number;
  minHeightClass: string;
  isSource: boolean;
  isTargetCandidate: boolean;
  isInvalid: boolean;
  invalidReason: string | null;
  onClick: () => void;
  onDoubleClick: () => void;
}) {
  const roomType = subject?.requiredRoomType ?? "THEORY";
  const isTheory = roomType === "THEORY";
  const codeTone = isTheory
    ? "text-zinc-500"
    : roomType === "LAB"
      ? "text-emerald-300"
      : "text-violet-300";
  const captionTone = isTheory ? "text-zinc-600" : "text-white/80";
  const titleTone = isTheory ? "text-zinc-900" : "text-white";

  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`relative flex h-full w-full flex-col justify-between rounded-md border p-2.5 text-left transition-all duration-150 hover:brightness-[1.03] hover:border-emerald-500/35 active:scale-95 touch-manipulation ${minHeightClass} ${SLOT_TYPE_STYLE[roomType]} ${
        isSource
          ? "border-emerald-500 ring-2 ring-emerald-500/70 ring-offset-1 ring-offset-white"
          : ""
      } ${isTargetCandidate ? "ring-1 ring-zinc-400/50" : ""} ${
        isInvalid ? "ring-2 ring-rose-400 ring-offset-1 ring-offset-white" : ""
      }`}
      title={[
        subject?.name ?? assignment.subjectId,
        teacher?.name ?? assignment.teacherId,
        room?.name ?? assignment.roomId,
        group?.groupName ?? assignment.classGroupId,
        span > 1 ? `${span} periods` : "",
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {isSource ? (
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400 ring-2 ring-white" />
      ) : null}
      <div className="min-w-0">
        <p
          className={`text-xs font-bold leading-snug tracking-tight break-words ${titleTone}`}
        >
          <span className={codeTone}>
            {subject?.code ?? assignment.subjectId}
          </span>
          {subject?.name ? (
            <span
              className={`font-medium ${isTheory ? "text-zinc-800" : "text-white/90"}`}
            >
              {" "}
              · {subject.name}
            </span>
          ) : null}
          {span > 1 ? (
            <span
              className={`ml-1 inline-flex rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                isTheory
                  ? "bg-zinc-200 text-zinc-600"
                  : "bg-white/15 text-white/90"
              }`}
            >
              ×{span}
            </span>
          ) : null}
        </p>
        <p
          className={`mt-1 flex items-start gap-1 text-[11px] leading-snug ${captionTone}`}
        >
          <User className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
          <span className="min-w-0 break-words">
            {teacher?.name ?? assignment.teacherId}
          </span>
        </p>
        <p className={`flex items-start gap-1 text-[11px] leading-snug ${captionTone}`}>
          <MapPin className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
          <span className="min-w-0 break-words">
            {room?.name ?? assignment.roomId}
          </span>
        </p>
        <p className={`flex items-start gap-1 text-[11px] leading-snug ${captionTone}`}>
          <Users className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
          <span className="min-w-0 break-words">
            {group?.groupName ?? assignment.classGroupId}
          </span>
        </p>
      </div>
      {isInvalid && invalidReason ? (
        <p className="mt-1 rounded bg-rose-500/90 px-1 py-0.5 text-[10px] font-semibold leading-snug text-white">
          {invalidReason}
        </p>
      ) : null}
    </button>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200/80 bg-zinc-50/70 px-3 py-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
        {label}
      </p>
      <p className="mt-1 text-sm font-medium leading-relaxed text-zinc-900">
        {value}
      </p>
    </div>
  );
}

function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-10">
      <div className="flex h-10 w-10 items-center justify-center rounded-md border border-zinc-200/80 bg-zinc-50 text-zinc-400">
        <CalendarX className="h-5 w-5 text-emerald-500" />
      </div>
      <div>
        <h3 className="text-sm font-bold tracking-tight text-zinc-900">
          {title}
        </h3>
        <p className="mt-1 max-w-md text-sm leading-relaxed text-zinc-600">
          {description}
        </p>
      </div>
      {onAction ? (
        <button
          type="button"
          onClick={onAction}
          className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98]"
        >
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}

export default ScheduleDashboard;
