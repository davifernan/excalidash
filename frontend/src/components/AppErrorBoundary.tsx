import React from "react";
import { AlertTriangle } from "lucide-react";

interface AppErrorBoundaryProps {
  children: React.ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorId: string | null;
}

/**
 * Outermost crash net for the application.
 *
 * A render error anywhere below this point unmounts the whole React tree and
 * leaves an empty document behind. NIL-262 gave the handled failures a voice;
 * a thrown one was still silent. This says what happened, offers a way back,
 * and shows a reference that also appears in the console, so a report and a
 * log line can be matched up later.
 *
 * Deliberately plain: the visual language of the shell belongs to M2 (NIL-343).
 * Deliberately outside the router: it has to survive a provider that throws,
 * which is why the way back is a location change rather than a navigation.
 */
const newErrorId = (): string => {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid.slice(0, 8);
  return Math.random().toString(16).slice(2, 10);
};

export class AppErrorBoundary extends React.Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { hasError: false, errorId: null };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    const errorId = newErrorId();
    this.setState({ errorId });
    console.error(`[crash ${errorId}]`, error, errorInfo.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false, errorId: null });
  };

  private handleGoHome = (): void => {
    window.location.assign("/");
  };

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="min-h-screen bg-slate-50 dark:bg-neutral-950 flex items-center justify-center p-6"
      >
        <div className="max-w-md w-full text-center">
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-500" aria-hidden="true" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900 dark:text-neutral-100">
            Something broke on this screen
          </h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-neutral-400">
            Your drawings are safe. This is the interface failing, not your data.
          </p>
          <div className="mt-6 flex flex-col sm:flex-row gap-2 justify-center">
            <button
              type="button"
              onClick={this.handleRetry}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleGoHome}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-neutral-700 text-sm font-medium text-slate-700 dark:text-neutral-200 hover:bg-slate-100 dark:hover:bg-neutral-900"
            >
              Back to drawings
            </button>
          </div>
          {this.state.errorId && (
            <p className="mt-6 text-xs text-slate-500 dark:text-neutral-500">
              Reference{" "}
              <code className="font-mono text-slate-700 dark:text-neutral-300">
                {this.state.errorId}
              </code>{" "}
              — include it when reporting this.
            </p>
          )}
        </div>
      </div>
    );
  }
}
