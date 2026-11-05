"use client";

import { useCallback, useMemo, useState } from "react";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { FileUpload } from "./components/FileUpload";
import { ScheduleDashboard } from "./components/ScheduleDashboard";
import {
  StepIndicator,
  type WorkflowStep,
} from "./components/StepIndicator";
import {
  LanguageProvider,
  LanguageSwitcher,
  useLanguage,
} from "./context/LanguageContext";
import { ToastProvider, useToast } from "./context/ToastContext";
import {
  handleExportExcel,
  handleExportPdf,
  type ExportMeta,
} from "./lib/exportSchedule";
import type { ScheduleInput, ScheduleResult } from "./types/schedule";

export type AppView = "upload" | "dashboard";

const SEED_PRESETS = [42, 7, 123, 2026] as const;

function AppShell() {
  const { t } = useLanguage();
  const { pushToast } = useToast();
  const [view, setView] = useState<AppView>("upload");
  const [scheduleResult, setScheduleResult] = useState<ScheduleResult | null>(
    null
  );
  const [scheduleInput, setScheduleInput] = useState<ScheduleInput | null>(
    null
  );
  const [seed, setSeed] = useState<number>(42);
  const [customSeed, setCustomSeed] = useState("42");
  const [busy, setBusy] = useState(false);
  const [hasPreviewData, setHasPreviewData] = useState(false);
  const [hasPreviewErrors, setHasPreviewErrors] = useState(false);

  const workflowStep: WorkflowStep = useMemo(() => {
    if (view === "dashboard") return 4;
    if (busy) return 3;
    if (hasPreviewData) return hasPreviewErrors ? 2 : 2;
    return 1;
  }, [view, busy, hasPreviewData, hasPreviewErrors]);

  const onScheduleGenerated = useCallback(
    (result: ScheduleResult, input: ScheduleInput) => {
      setScheduleResult(result);
      setScheduleInput(input);
      setView("dashboard");
      setBusy(false);
    },
    []
  );

  const resetToUpload = useCallback(() => {
    setScheduleResult(null);
    setScheduleInput(null);
    setView("upload");
    setBusy(false);
    setHasPreviewData(false);
    setHasPreviewErrors(false);
  }, []);

  const exportExcel = useCallback(
    async (meta?: ExportMeta) => {
      if (!scheduleResult || !scheduleInput) return;
      if (typeof window === "undefined") return;
      try {
        await handleExportExcel(scheduleResult, scheduleInput, meta);
        pushToast(t("toast.exportOk"), "success");
      } catch {
        pushToast(t("toast.exportFail"), "error");
      }
    },
    [scheduleResult, scheduleInput, pushToast, t]
  );

  const exportPdf = useCallback((_meta?: ExportMeta) => {
    if (typeof window === "undefined") return;
    handleExportPdf();
    pushToast(t("toast.exportOk"), "success");
  }, [pushToast, t]);

  const applySeedInput = useCallback(() => {
    const parsed = Number.parseInt(customSeed, 10);
    if (Number.isFinite(parsed)) setSeed(parsed);
  }, [customSeed]);

  const status = useMemo(() => {
    if (busy) {
      return { label: t("steps.process"), tone: "neutral" as const };
    }
    if (view === "upload") {
      return { label: t("app.statusAwaiting"), tone: "neutral" as const };
    }
    if (!scheduleResult) {
      return { label: t("app.statusNoResult"), tone: "neutral" as const };
    }
    if (scheduleResult.hardConflictCount === 0) {
      return { label: t("app.statusZeroConflicts"), tone: "ok" as const };
    }
    return {
      label: t("app.statusHardConflicts", {
        count: scheduleResult.hardConflictCount,
      }),
      tone: "bad" as const,
    };
  }, [view, scheduleResult, busy, t]);

  return (
    <div className="print-root min-h-screen bg-zinc-50 text-zinc-900">
      <header className="app-shell-nav sticky top-0 z-40 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md pt-safe">
        <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-3 py-2 sm:px-5 sm:py-2.5">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 sm:gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-zinc-200/80 bg-zinc-900 text-xs font-bold tracking-tight text-white">
                AI
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-bold tracking-tight text-zinc-900">
                  {t("app.title")}
                </p>
                <p className="hidden truncate text-[11px] font-medium text-zinc-400 sm:block">
                  {t("app.subtitle")}
                </p>
              </div>
            </div>
            <span
              className={
                status.tone === "ok"
                  ? "inline-flex max-w-[46%] shrink-0 items-center truncate rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-[10px] font-semibold text-emerald-700 sm:max-w-none sm:text-[11px]"
                  : status.tone === "bad"
                    ? "inline-flex max-w-[46%] shrink-0 items-center truncate rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1 text-[10px] font-semibold text-rose-700 sm:max-w-none sm:text-[11px]"
                    : "inline-flex max-w-[46%] shrink-0 items-center truncate rounded-md border border-zinc-200/80 bg-zinc-100 px-2 py-1 text-[10px] font-semibold text-zinc-600 sm:max-w-none sm:text-[11px]"
              }
            >
              {status.tone === "ok" ? (
                <CheckCircle2 className="mr-1.5 h-3.5 w-3.5 shrink-0 text-emerald-500 sm:h-4 sm:w-4" />
              ) : (
                <span
                  className={
                    status.tone === "bad"
                      ? "mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500"
                      : "mr-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-400"
                  }
                />
              )}
              <span className="truncate">{status.label}</span>
            </span>
          </div>

          <div className="flex items-center gap-2 overflow-x-auto scrollbar-thin pb-0.5">
            <div className="shrink-0">
              <LanguageSwitcher />
            </div>

            <label className="flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-md border border-zinc-200/80 bg-white px-2 py-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {t("app.seed")}
              </span>
              <select
                value={
                  SEED_PRESETS.includes(seed as (typeof SEED_PRESETS)[number])
                    ? seed
                    : "custom"
                }
                onChange={(e) => {
                  if (e.target.value === "custom") return;
                  const next = Number(e.target.value);
                  setSeed(next);
                  setCustomSeed(String(next));
                }}
                className="bg-transparent text-xs font-semibold text-zinc-800 outline-none"
                aria-label={t("app.seedAria")}
              >
                {SEED_PRESETS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
                <option value="custom">{t("app.seedCustom")}</option>
              </select>
              <input
                type="number"
                value={customSeed}
                onChange={(e) => setCustomSeed(e.target.value)}
                onBlur={applySeedInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applySeedInput();
                }}
                className="w-14 rounded border border-zinc-200/80 bg-zinc-50 px-1.5 py-0.5 text-xs tabular-nums text-zinc-900 outline-none focus:border-emerald-600/40 sm:w-16"
                aria-label={t("app.seedCustomAria")}
              />
            </label>

            {view === "dashboard" ? (
              <button
                type="button"
                onClick={resetToUpload}
                className="inline-flex min-h-[40px] shrink-0 items-center rounded-md border border-transparent px-2.5 py-1 text-xs font-medium text-zinc-600 transition-transform hover:border-zinc-200 hover:bg-zinc-100 hover:text-zinc-900 active:scale-95"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                {t("app.newUpload")}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <StepIndicator current={workflowStep} />

      <p className="print-only-title px-4 pt-2">
        {t("app.printTitle", { seed: scheduleResult?.seed ?? seed })}
      </p>

      <main className={view === "dashboard" ? "print-schedule" : undefined}>
        {view === "upload" ? (
          <FileUpload
            seed={seed}
            onScheduleGenerated={onScheduleGenerated}
            onBusyChange={setBusy}
            onPreviewStateChange={(hasData, hasErrors) => {
              setHasPreviewData(hasData);
              setHasPreviewErrors(hasErrors);
            }}
          />
        ) : scheduleResult && scheduleInput ? (
          <ScheduleDashboard
            result={scheduleResult}
            input={scheduleInput}
            onExportExcel={exportExcel}
            onExportPdf={exportPdf}
            onReset={resetToUpload}
            onResultChange={setScheduleResult}
          />
        ) : (
          <div className="mx-auto max-w-lg p-8">
            <div className="rounded-lg border border-zinc-200/80 bg-white p-6">
              <h2 className="text-lg font-bold tracking-tight text-zinc-900">
                {t("app.noScheduleTitle")}
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-zinc-600">
                {t("app.noScheduleBody")}
              </p>
              <button
                type="button"
                onClick={resetToUpload}
                className="mt-4 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white transition-all duration-150 hover:bg-zinc-800 active:scale-[0.98]"
              >
                {t("app.goUpload")}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </LanguageProvider>
  );
}
