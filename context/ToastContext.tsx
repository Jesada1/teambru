"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "success" | "error";

export type ToastItem = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastContextValue = {
  toasts: ToastItem[];
  pushToast: (message: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, tone: ToastTone = "info") => {
      const id = ++toastSeq;
      setToasts((prev) => [...prev.slice(-4), { id, message, tone }]);
      if (typeof window !== "undefined") {
        window.setTimeout(() => dismissToast(id), 3800);
      }
    },
    [dismissToast]
  );

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast }),
    [toasts, pushToast, dismissToast]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-[min(100%-2rem,22rem)] flex-col gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={
              toast.tone === "success"
                ? "pointer-events-auto rounded-lg border border-emerald-500/25 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 shadow-sm"
                : toast.tone === "error"
                  ? "pointer-events-auto rounded-lg border border-rose-500/25 bg-rose-50 px-3 py-2 text-sm font-medium text-rose-900 shadow-sm"
                  : "pointer-events-auto rounded-lg border border-zinc-200/80 bg-white px-3 py-2 text-sm font-medium text-zinc-800 shadow-sm"
            }
          >
            <div className="flex items-start justify-between gap-2">
              <p className="leading-relaxed">{toast.message}</p>
              <button
                type="button"
                onClick={() => dismissToast(toast.id)}
                className="shrink-0 text-xs text-zinc-400 hover:text-zinc-700"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
