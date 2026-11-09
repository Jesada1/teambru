"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { AlertTriangle, FileSpreadsheet, Sparkles, Wand2, Zap } from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import { useToast } from "../context/ToastContext";
import { solveSchedule } from "../engine/solver";
import { generateMediumDataset, DATASET_ROW_TARGETS, type DatasetSize } from "../lib/mockData";
import {
  buildParsedUploadState,
  buildScheduleInputFromState,
  downloadExcelTemplate,
  downloadMockDataset,
  parseUploadFile,
  type ParsedUploadState,
  type PreviewRow,
} from "../lib/parseUploadFile";
import {
  autoFixRows,
  type InvalidRow,
} from "../lib/validations/autoFix";
import type { ScheduleInput, ScheduleResult } from "../types/schedule";
import type { RowValidationIssue } from "../lib/validations/upload";
import type { TranslationKey } from "../lib/i18n";

export type FileUploadProps = {
  seed?: number;
  onScheduleGenerated?: (result: ScheduleResult, input: ScheduleInput) => void;
  onBusyChange?: (busy: boolean) => void;
  onPreviewStateChange?: (hasData: boolean, hasErrors: boolean) => void;
};

const PREVIEW_COLUMNS = [
  "entity",
  "id",
  "name",
  "code",
  "type",
  "groupName",
  "day",
  "period",
  "startTime",
  "endTime",
  "capacity",
  "studentCount",
  "requiredRoomType",
  "assignedTeacherId",
  "classGroupId",
  "unavailableSlots",
] as const;

const ISSUE_KEY: Record<RowValidationIssue["code"], TranslationKey> = {
  duplicate_id: "upload.issue.duplicate_id",
  missing_field: "upload.issue.missing_field",
  invalid_format: "upload.issue.invalid_format",
  capacity: "upload.issue.capacity",
  teacher_capacity: "upload.issue.teacher_capacity",
};

function fieldHasError(issues: RowValidationIssue[], field: string): boolean {
  return issues.some(
    (i) => !i.field || i.field === field || i.field.startsWith(`${field}.`)
  );
}

function emptyState(): ParsedUploadState {
  return {
    teachers: [],
    subjects: [],
    rooms: [],
    classGroups: [],
    timeSlots: [],
    previewRows: [],
    errorRowCount: 0,
    totalRowCount: 0,
  };
}

function runAutoFixOnState(state: ParsedUploadState): ParsedUploadState {
  if (!state.previewRows.length) return state;
  const allRows: InvalidRow[] = state.previewRows.map((row) => ({
    rowIndex: row.rowIndex,
    entity: row.entity,
    raw: row.raw,
    issues: row.issues,
  }));
  const { fixedRows, remainingErrors } = autoFixRows(allRows);
  const rebuiltRaw: Record<string, unknown>[] = [
    ...fixedRows.map((fixed) => ({
      ...(fixed.data as Record<string, unknown>),
      entity: fixed.entity,
    })),
    ...remainingErrors.map((err) => ({
      ...err.raw,
      entity: err.entity,
    })),
  ];
  return buildParsedUploadState(rebuiltRaw);
}

export function FileUpload({
  seed = 42,
  onScheduleGenerated,
  onBusyChange,
  onPreviewStateChange,
}: FileUploadProps) {
  const { t } = useLanguage();
  const { pushToast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [state, setState] = useState<ParsedUploadState>(emptyState);
  const [solving, setSolving] = useState(false);
  const [solveProgress, setSolveProgress] = useState(0);
  const [solveMessage, setSolveMessage] = useState<string | null>(null);
  const [lastSolveInput, setLastSolveInput] = useState<ScheduleInput | null>(
    null
  );
  const cancelSolveRef = useRef(false);
  const progressTimerRef = useRef<number | null>(null);

  const setBusy = useCallback(
    (busy: boolean) => {
      setSolving(busy);
      onBusyChange?.(busy);
    },
    [onBusyChange]
  );

  const clearProgressTimer = useCallback(() => {
    if (progressTimerRef.current != null) {
      window.clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const cancelSolve = useCallback(() => {
    cancelSolveRef.current = true;
    clearProgressTimer();
    setBusy(false);
    setSolveProgress(0);
    setSolveMessage(t("dash.progress.cancel"));
    pushToast(t("dash.progress.cancel"), "info");
  }, [clearProgressTimer, setBusy, pushToast, t]);

  const publishPreview = useCallback(
    (next: ParsedUploadState) => {
      setState(next);
      onPreviewStateChange?.(next.totalRowCount > 0, next.errorRowCount > 0);
    },
    [onPreviewStateChange]
  );

  const resetUpload = useCallback(() => {
    setFileName(null);
    setParseError(null);
    setSolveMessage(null);
    publishPreview(emptyState());
    if (inputRef.current) inputRef.current.value = "";
  }, [publishPreview]);

  const ingestRows = useCallback(
    (rows: Record<string, unknown>[], name: string) => {
      const next = buildParsedUploadState(rows);
      if (next.totalRowCount === 0) {
        setParseError(t("upload.msg.noRecognizable"));
        publishPreview(emptyState());
        setFileName(name);
        return;
      }
      setParseError(null);
      setSolveMessage(null);
      setFileName(name);
      publishPreview(next);
    },
    [t, publishPreview]
  );

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      const file = files?.[0];
      if (!file) return;
      try {
        setParseError(null);
        const rows = await parseUploadFile(file);
        ingestRows(rows, file.name);
      } catch (err) {
        resetUpload();
        setParseError(
          err instanceof Error ? err.message : t("upload.msg.parseFail")
        );
        setFileName(file.name);
      }
    },
    [ingestRows, resetUpload, t]
  );

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      void handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const handleApplyAutoFix = useCallback(() => {
    if (state.previewRows.length === 0) {
      setSolveMessage(t("upload.msg.noRows"));
      return;
    }
    const errorCountBefore = state.errorRowCount;
    const next = runAutoFixOnState(state);
    const removed = Math.max(0, state.totalRowCount - next.totalRowCount);
    const cleared = Math.max(0, errorCountBefore - next.errorRowCount);
    const removedText =
      removed > 0 ? t("upload.msg.removedDup", { n: removed }) : "";
    publishPreview(next);
    if (next.errorRowCount === 0) {
      setSolveMessage(
        t("upload.msg.autofixOk", { cleared, removed: removedText })
      );
    } else {
      setSolveMessage(
        t("upload.msg.autofixPartial", {
          errors: next.errorRowCount,
          removed: removedText,
        })
      );
    }
  }, [state, t, publishPreview]);

  const solveFromInput = useCallback(
    (input: ScheduleInput, successToastKey: TranslationKey = "toast.scheduleReady") => {
      cancelSolveRef.current = false;
      setLastSolveInput(input);
      setBusy(true);
      setSolveProgress(8);
      setSolveMessage(t("upload.msg.solving"));
      clearProgressTimer();
      progressTimerRef.current = window.setInterval(() => {
        setSolveProgress((p) => Math.min(90, p + 7));
      }, 160);
      window.setTimeout(() => {
        if (cancelSolveRef.current) {
          clearProgressTimer();
          return;
        }
        try {
          const result = solveSchedule(input, seed);
          if (cancelSolveRef.current) return;
          setSolveProgress(100);
          const partialNote =
            result.isPartial || result.completionRate < 100
              ? ` · ${t("dash.partialBadge", {
                  rate: result.completionRate.toFixed(1),
                })}`
              : "";
          setSolveMessage(
            result.assignments.length === 0
              ? t("upload.msg.solvedEmpty", { ms: result.executionTimeMs })
              : `${t("upload.msg.solvedOk", {
                  count: result.assignments.length,
                  ms: result.executionTimeMs,
                })}${partialNote}`
          );
          pushToast(t(successToastKey), "success");
          onScheduleGenerated?.(result, input);
        } catch (err) {
          if (cancelSolveRef.current) return;
          const msg =
            err instanceof Error ? err.message : t("upload.msg.solverFail");
          setSolveMessage(msg);
          pushToast(msg, "error");
        } finally {
          clearProgressTimer();
          setBusy(false);
          window.setTimeout(() => setSolveProgress(0), 500);
        }
      }, 40);
    },
    [seed, onScheduleGenerated, pushToast, setBusy, t, clearProgressTimer]
  );

  const confirmAndSolve = useCallback(() => {
    const { input, blockingErrors } = buildScheduleInputFromState(state);
    if (!input) {
      const msg = t("upload.msg.cannotSolve", {
        errors: blockingErrors.join(" "),
      });
      setSolveMessage(msg);
      pushToast(msg, "error");
      return;
    }
    solveFromInput(input);
  }, [state, t, pushToast, solveFromInput]);

  const handleAutoFixAndGenerate = useCallback(() => {
    pushToast(t("toast.autofixGenerate"), "info");
    const cleaned = runAutoFixOnState(state);
    publishPreview(cleaned);
    const { input, blockingErrors } = buildScheduleInputFromState(cleaned);
    if (!input) {
      const msg = t("upload.msg.cannotSolve", {
        errors: blockingErrors.join(" "),
      });
      setSolveMessage(msg);
      pushToast(msg, "error");
      return;
    }
    solveFromInput(input);
  }, [state, t, pushToast, publishPreview, solveFromInput]);

  const handleQuickDemo = useCallback(() => {
    pushToast(t("toast.demoStart"), "info");
    const input = generateMediumDataset();
    solveFromInput(input, "toast.demoDone");
  }, [pushToast, t, solveFromInput]);

  useEffect(() => {
    return () => clearProgressTimer();
  }, [clearProgressTimer]);

  const templates: Array<{ size: DatasetSize; labelKey: TranslationKey }> = [
    { size: "small", labelKey: "upload.templateSmall" },
    { size: "medium", labelKey: "upload.templateMedium" },
    { size: "large", labelKey: "upload.templateLarge" },
  ];

  const visibleColumns = useMemo(() => {
    const used = new Set<string>(["entity"]);
    for (const row of state.previewRows) {
      for (const [key, value] of Object.entries(row.values)) {
        if (value) used.add(key);
      }
    }
    return PREVIEW_COLUMNS.filter((c) => used.has(c));
  }, [state.previewRows]);

  const canSolve =
    state.totalRowCount > 0 && state.errorRowCount === 0 && !solving;
  const hasErrors = state.errorRowCount > 0;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 p-3 pb-28 sm:p-5 md:pb-5">
      {/* One-click demo hero */}
      <section className="rounded-lg border border-zinc-200/80 bg-white p-3 sm:p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0 md:max-w-xl">
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Quick start
            </p>
            <h2 className="mt-1 text-lg font-bold tracking-tight text-zinc-900 sm:text-xl">
              {t("upload.title")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              {t("upload.quickDemoHint")}
            </p>
          </div>
          <button
            type="button"
            onClick={handleQuickDemo}
            disabled={solving}
            className="inline-flex min-h-[48px] w-full shrink-0 items-center justify-center rounded-md bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition-transform duration-150 hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
          >
            {solving ? (
              <Sparkles className="mr-2 h-4 w-4 shrink-0 text-emerald-200" />
            ) : (
              <Zap className="mr-2 h-4 w-4 shrink-0 text-amber-300" />
            )}
            {solving ? t("upload.generating") : t("upload.quickDemo")}
          </button>
        </div>
      </section>

      {/* Upload + templates */}
      <section className="rounded-lg border border-zinc-200/80 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {t("upload.templates")}
            </p>
            <p className="mt-1 text-sm leading-relaxed text-zinc-600">
              {t("upload.subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {templates.map((tmpl) => (
              <button
                key={tmpl.size}
                type="button"
                onClick={() => downloadMockDataset(tmpl.size)}
                className="rounded-md border border-transparent px-3 py-1.5 text-sm font-medium text-zinc-700 transition-all duration-150 hover:border-zinc-200 hover:bg-zinc-50 active:scale-[0.98]"
              >
                {t(tmpl.labelKey, { n: DATASET_ROW_TARGETS[tmpl.size] })}
              </button>
            ))}
            <button
              type="button"
              onClick={() => downloadExcelTemplate("medium")}
              className="inline-flex items-center rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-sm font-medium text-emerald-800 transition-all duration-150 hover:bg-emerald-500/15 active:scale-[0.98]"
            >
              <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0 text-emerald-600" />
              {t("upload.templateExcel")}
            </button>
          </div>
        </div>

        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
          }}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDragOver(false);
          }}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={
            dragOver
              ? "mt-3 flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-emerald-500 bg-emerald-500/5 px-4 py-6 text-center touch-manipulation sm:min-h-[180px] sm:px-6 sm:py-10"
              : "mt-3 flex min-h-[140px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-zinc-300 bg-zinc-50/80 px-4 py-6 text-center transition-all touch-manipulation hover:border-emerald-500/50 hover:bg-emerald-500/5 active:scale-[0.99] sm:min-h-[180px] sm:px-6 sm:py-10"
          }
        >
          <p className="hidden text-sm font-semibold tracking-tight text-zinc-900 sm:block">
            {t("upload.dropzoneTitle")}
          </p>
          <p className="text-sm font-semibold tracking-tight text-zinc-900 sm:hidden">
            {t("upload.tapToSelect")}
          </p>
          <p className="mt-1 text-xs text-zinc-500">{t("upload.dropzoneHint")}</p>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              inputRef.current?.click();
            }}
            className="mt-4 inline-flex min-h-[48px] items-center justify-center rounded-md bg-zinc-900 px-4 text-sm font-semibold text-white transition-transform active:scale-95 sm:hidden"
          >
            <FileSpreadsheet className="mr-2 h-4 w-4 shrink-0" />
            {t("upload.tapToSelect")}
          </button>
          {fileName ? (
            <p className="mt-3 max-w-full truncate px-2 text-xs text-zinc-600">
              {t("upload.loaded", { name: fileName })}
            </p>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>

        {parseError ? (
          <p className="mt-3 rounded-md border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-700">
            {parseError}
          </p>
        ) : null}
      </section>

      {state.totalRowCount > 0 ? (
        <section className="rounded-lg border border-zinc-200/80 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 px-3 py-2.5">
            <div>
              <h3 className="text-sm font-bold tracking-tight text-zinc-900">
                {t("upload.previewTitle")}
              </h3>
              <p
                className={
                  state.errorRowCount > 0
                    ? "mt-0.5 text-sm text-rose-700"
                    : "mt-0.5 text-sm text-emerald-700"
                }
              >
                {state.errorRowCount > 0
                  ? t("upload.errorsFound", {
                      errors: state.errorRowCount,
                      total: state.totalRowCount,
                    })
                  : t("upload.allValid", { total: state.totalRowCount })}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-left text-sm">
              <thead>
                <tr className="bg-zinc-50 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <th className="px-3 py-2">#</th>
                  {visibleColumns.map((col) => (
                    <th key={col} className="px-3 py-2">
                      {col}
                    </th>
                  ))}
                  <th className="px-3 py-2">{t("upload.statusCol")}</th>
                </tr>
              </thead>
              <tbody>
                {state.previewRows.map((row, idx) => (
                  <PreviewTableRow
                    key={row.key}
                    row={row}
                    displayIndex={idx + 1}
                    columns={visibleColumns}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="hidden flex-col gap-2 sm:flex sm:flex-row sm:flex-wrap sm:items-center">
        {hasErrors ? (
          <button
            type="button"
            onClick={handleAutoFixAndGenerate}
            disabled={solving || state.totalRowCount === 0}
            className="inline-flex min-h-[44px] items-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition-transform duration-150 hover:bg-emerald-700 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Wand2 className="mr-2 h-4 w-4 shrink-0 text-emerald-200" />
            {solving ? t("upload.generating") : t("upload.autoFixGenerate")}
          </button>
        ) : null}

        <button
          type="button"
          onClick={resetUpload}
          className="min-h-[44px] rounded-md border border-transparent px-4 py-2 text-sm font-medium text-zinc-600 transition-transform duration-150 hover:border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900 active:scale-95"
        >
          {t("upload.reupload")}
        </button>
        <button
          type="button"
          onClick={handleApplyAutoFix}
          disabled={state.totalRowCount === 0 || solving}
          className="inline-flex min-h-[44px] items-center rounded-md border border-zinc-200/80 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-transform duration-150 hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Wand2 className="mr-2 h-4 w-4 shrink-0 text-emerald-500" />
          {t("upload.autoFix")}
        </button>
        <button
          type="button"
          onClick={confirmAndSolve}
          disabled={!canSolve}
          className={
            hasErrors
              ? "min-h-[44px] rounded-md border border-zinc-200/80 bg-white px-4 py-2 text-sm font-medium text-zinc-700 transition-transform duration-150 hover:bg-zinc-50 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
              : "min-h-[44px] rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition-transform duration-150 hover:bg-zinc-800 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          }
        >
          {solving ? t("upload.generating") : t("upload.confirm")}
        </button>
      </section>

      {solving || solveProgress > 0 ? (
        <div className="rounded-md border border-zinc-200/80 bg-white p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-zinc-700">
              {t("dash.progress.solving")}
            </p>
            <div className="flex gap-2">
              {solving ? (
                <button
                  type="button"
                  onClick={cancelSolve}
                  className="rounded-md border border-zinc-200/80 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700"
                >
                  {t("dash.progress.cancel")}
                </button>
              ) : lastSolveInput ? (
                <button
                  type="button"
                  onClick={() => solveFromInput(lastSolveInput)}
                  className="rounded-md border border-zinc-200/80 bg-zinc-50 px-2.5 py-1 text-xs font-semibold text-zinc-700"
                >
                  {t("dash.progress.retry")}
                </button>
              ) : null}
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div
              className="h-full rounded-full bg-emerald-600 transition-all duration-150"
              style={{ width: `${solveProgress}%` }}
            />
          </div>
        </div>
      ) : null}

      {solveMessage ? (
        <p className="rounded-md border border-zinc-200/80 bg-zinc-50 px-3 py-2 text-sm leading-relaxed text-zinc-700">
          {solveMessage}
        </p>
      ) : null}

      {/* Mobile sticky actions */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-200/80 bg-white/95 backdrop-blur-md md:hidden pb-safe">
        <div className="mx-auto flex max-w-7xl gap-2 overflow-x-auto scrollbar-thin px-3 py-2">
          <button
            type="button"
            onClick={handleApplyAutoFix}
            disabled={state.totalRowCount === 0 || solving}
            className="inline-flex min-h-[48px] shrink-0 items-center rounded-md border border-zinc-200/80 bg-white px-3 text-sm font-semibold text-zinc-800 transition-transform active:scale-95 disabled:opacity-40"
          >
            <Wand2 className="mr-2 h-4 w-4 shrink-0 text-emerald-500" />
            {t("upload.autoFix")}
          </button>
          {hasErrors ? (
            <button
              type="button"
              onClick={handleAutoFixAndGenerate}
              disabled={solving || state.totalRowCount === 0}
              className="inline-flex min-h-[48px] shrink-0 items-center rounded-md bg-emerald-600 px-3 text-sm font-semibold text-white transition-transform active:scale-95 disabled:opacity-40"
            >
              <Wand2 className="mr-2 h-4 w-4 shrink-0 text-emerald-200" />
              {solving ? t("upload.generating") : t("upload.autoFixGenerate")}
            </button>
          ) : (
            <button
              type="button"
              onClick={confirmAndSolve}
              disabled={!canSolve}
              className="inline-flex min-h-[48px] shrink-0 items-center rounded-md bg-zinc-900 px-3 text-sm font-semibold text-white transition-transform active:scale-95 disabled:opacity-40"
            >
              {solving ? t("upload.generating") : t("upload.confirm")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewTableRow({
  row,
  displayIndex,
  columns,
}: {
  row: PreviewRow;
  displayIndex: number;
  columns: readonly string[];
}) {
  const { t } = useLanguage();
  const hasError = row.issues.length > 0;

  const issueTitle = (issues: RowValidationIssue[], field?: string) => {
    const relevant = field
      ? issues.filter(
          (i) =>
            !i.field || i.field === field || i.field.startsWith(`${field}.`)
        )
      : issues;
    if (!relevant.length) return "";
    return relevant
      .map((i) => `${t(ISSUE_KEY[i.code])}: ${i.message}`)
      .join("\n");
  };

  return (
    <tr className={hasError ? "bg-rose-50/40" : "bg-white"}>
      <td className="px-3 py-2 tabular-nums text-zinc-500">{displayIndex}</td>
      {columns.map((col) => {
        const value = row.values[col] ?? "";
        const errored = fieldHasError(row.issues, col);
        const title = errored ? issueTitle(row.issues, col) : undefined;
        const code = row.issues.find(
          (i) => !i.field || i.field === col
        )?.code;

        return (
          <td key={col} className="px-3 py-2 align-top">
            {errored ? (
              <span
                title={title}
                className="inline-flex max-w-[14rem] items-center gap-1 rounded-md border border-rose-500/20 bg-rose-500/10 px-1.5 py-0.5 text-rose-800"
              >
                <AlertTriangle className="mr-1 h-3.5 w-3.5 shrink-0 text-rose-500" />
                <span className="truncate">{value || "—"}</span>
                <span className="shrink-0 rounded bg-rose-600 px-1 text-[10px] font-semibold text-white">
                  {code === "duplicate_id"
                    ? t("upload.badgeDup")
                    : code === "missing_field"
                      ? t("upload.badgeIncomplete")
                      : t("upload.badgeErr")}
                </span>
              </span>
            ) : (
              <span className="text-zinc-800">{value}</span>
            )}
          </td>
        );
      })}
      <td className="px-3 py-2">
        {hasError ? (
          <span
            title={issueTitle(row.issues)}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-0.5 text-[11px] font-semibold text-rose-700"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" />
            {t("upload.rowErrors", { count: row.issues.length })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t("upload.rowOk")}
          </span>
        )}
      </td>
    </tr>
  );
}

export default FileUpload;
