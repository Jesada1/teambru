"use client";

import { ShieldCheck } from "lucide-react";
import {
  DEMO_ACCOUNTS,
  useDemoAuth,
  type DemoRole,
} from "../context/DemoAuthContext";
import { useLanguage } from "../context/LanguageContext";

const ROLE_ORDER: DemoRole[] = ["admin", "teacher", "student"];

export function JudgeDemoBar() {
  const { t, lang } = useLanguage();
  const { role, account, setRole } = useDemoAuth();

  return (
    <div className="no-print border-b border-amber-500/30 bg-amber-50/90 text-amber-950">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-2 px-3 py-2 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <ShieldCheck className="h-4 w-4 shrink-0 text-amber-700" />
            <p className="truncate text-xs font-semibold uppercase tracking-wider text-amber-800 sm:text-[13px] sm:normal-case sm:tracking-normal">
              {t("judge.title")}
            </p>
          </div>
          <p className="rounded-md border border-amber-500/30 bg-white/80 px-2 py-1 text-[11px] font-medium text-amber-900">
            {t("judge.active", {
              user: account.username,
              role:
                lang === "th" ? account.displayNameTh : account.displayNameEn,
              pass: account.passwordHint,
            })}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {ROLE_ORDER.map((r) => {
            const active = role === r;
            const labelKey =
              r === "admin"
                ? "judge.role.admin"
                : r === "teacher"
                  ? "judge.role.teacher"
                  : "judge.role.student";
            return (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={
                  active
                    ? "inline-flex min-h-[36px] items-center rounded-md bg-amber-800 px-2.5 py-1.5 text-[11px] font-semibold text-white transition-transform active:scale-95 sm:text-xs"
                    : "inline-flex min-h-[36px] items-center rounded-md border border-amber-500/35 bg-white px-2.5 py-1.5 text-[11px] font-medium text-amber-900 transition-transform hover:bg-amber-100/80 active:scale-95 sm:text-xs"
                }
                title={`${DEMO_ACCOUNTS[r].username} / ${DEMO_ACCOUNTS[r].passwordHint}`}
              >
                {t(labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
