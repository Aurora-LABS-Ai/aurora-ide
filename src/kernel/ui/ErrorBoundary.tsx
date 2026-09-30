/**
 * ErrorBoundary — keeps one broken render from taking the window with it.
 *
 * React unmounts the WHOLE tree above an uncaught render error, and until
 * 2026-09-29 nothing in Aurora caught one. A model called a tool named `read`
 * with `path: {"item": "…"}`; the card's path helper handed the object to
 * `basename`, `.split` threw inside render, and the agent window went blank
 * mid-turn (aurora.log `ui.crash`, 2026-09-28T20:15Z). The runtime had
 * answered the call correctly; only the drawing failed, and it cost the user
 * the entire window.
 *
 * Style-agnostic on purpose: the kernel does not know whether it is inside
 * the IDE (Tailwind) or the agent window (`--agw-*`), so the caller passes
 * the fallback. `resetKey` lets a boundary try again when its input changes
 * (a streaming card whose result has since arrived).
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** What to draw instead. `reset` clears the error and re-renders the children. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Where the failure was, for the log line — `tool step`, `agent window`. */
  where: string;
  /** When this value changes, a caught error is cleared and the children retried. */
  resetKey?: unknown;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // `console.error` is what the `ui.console` sink forwards to aurora.log,
    // so the failure is on disk with its component stack even when nobody
    // had DevTools open.
    console.error(
      `[ErrorBoundary] render failed in ${this.props.where}:`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset);
    }
    return this.props.children;
  }
}
