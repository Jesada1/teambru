"use client";

import {
  Calendar,
  Check,
  ChevronRight,
  Cpu,
  FileCheck,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { useLanguage } from "../context/LanguageContext";
import type { TranslationKey } from "../lib/i18n";

export type WorkflowStep = 1 | 2 | 3 | 4;

const STEPS: Array<{
  step: WorkflowStep;
  key: TranslationKey;
  Icon: LucideIcon;
}> = [
  { step: 1, key: "steps.upload", Icon: Upload },
  { step: 2, key: "steps.review", Icon: FileCheck },
  { step: 3, key: "steps.process", Icon: Cpu },
  { step: 4, key: "steps.report", Icon: Calendar },
];

export function StepIndicator({ current }: { current: WorkflowStep }) {
  const { t } = useLanguage();

  return (
    <nav
      aria-label={t("steps.aria")}
      className="no-print border-b border-zinc-200/80 bg-zinc-50/80"
    >
      <ol className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-1.5 px-3 py-2 sm:gap-2 sm:px-5">
        {STEPS.map((item, index) => {
          const active = current === item.step;
          const done = current > item.step;
          const Icon = item.Icon;
          return (
            <li key={item.step} className="flex items-center gap-1.5 sm:gap-2">
              {index > 0 ? (
                <ChevronRight
                  className="hidden h-4 w-4 shrink-0 text-zinc-300 sm:block"
                  aria-hidden
                />
              ) : null}
              <div
                className={
                  active
                    ? "inline-flex items-center gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5"
                    : done
                      ? "inline-flex items-center gap-2 rounded-md border border-zinc-200/80 bg-white px-2.5 py-1.5"
                      : "inline-flex items-center gap-2 rounded-md border border-transparent px-2.5 py-1.5 opacity-55"
                }
              >
                <span className="relative flex h-5 w-5 items-center justify-center">
                  <span
                    className={
                      active
                        ? "flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-white"
                        : done
                          ? "flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-white"
                          : "flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 text-zinc-600"
                    }
                  >
                    {done ? (
                      <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                    ) : (
                      <Icon className="h-3 w-3 shrink-0" />
                    )}
                  </span>
                  {active ? (
                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  ) : null}
                </span>
                <span
                  className={
                    active
                      ? "text-xs font-semibold tracking-tight text-emerald-800 sm:text-sm"
                      : "text-xs font-medium tracking-tight text-zinc-600 sm:text-sm"
                  }
                >
                  {t(item.key)}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
