"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

type Props = { children: ReactNode };
type State = { hasError: boolean; message: string };

/**
 * Prevents agent/network/render failures from blanking the whole schedule UI.
 */
export class DashboardErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error.message || "Unexpected dashboard error",
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ScheduleDashboard crashed:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="mx-auto max-w-lg p-6">
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/10 p-5">
            <div className="flex items-center gap-2 text-rose-800">
              <AlertTriangle className="h-5 w-5 shrink-0" />
              <h2 className="text-sm font-bold tracking-tight">
                Dashboard recovery mode
              </h2>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-rose-700">
              {this.state.message}. The previous schedule state was not mutated
              by this crash. Reload the page to continue.
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: "" })}
              className="mt-4 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white transition-transform active:scale-95"
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default DashboardErrorBoundary;
