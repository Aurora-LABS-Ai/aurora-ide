/**
 * Per-model connection test.
 *
 * Sends one real, minimal turn using this model's exact saved
 * configuration — provider, base URL, key, API type, reasoning level,
 * extra request fields — and reports what actually came back.
 *
 * The result appears on hover *and* on keyboard focus, because hover is
 * not available to keyboard or touch users. The button's own icon
 * carries the verdict (plug → check → alert) so the outcome survives
 * without ever opening the panel, and without depending on colour.
 *
 * Clicking while a verdict is on screen DISMISSES it — it does not test
 * again. A test is a real, billed request to the provider, so it must
 * never be the accidental outcome of clicking the thing you were trying
 * to close. Once dismissed the panel stays shut under the pointer, and
 * the next click runs a fresh test; moving away and back brings the kept
 * verdict back.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { AgentIcon } from "../shared/AgentIcon";
import { testProviderModel, type ProviderTestReport } from "@/apps/agent/services/providers/provider-test";
import type { LLMModel } from "@/apps/agent/store/settings/useAgentSettingsStore";

type TestState = "idle" | "running" | "pass" | "warn" | "fail";

const ICON_FOR_STATE: Record<TestState, "plug" | "check" | "alert"> = {
  idle: "plug",
  running: "plug",
  pass: "check",
  warn: "alert",
  fail: "alert",
};

const LABEL_FOR_STATE: Record<TestState, string> = {
  idle: "Test this model",
  running: "Testing…",
  pass: "Test passed — hover for details",
  warn: "Connected, but reasoning was not returned — hover for details",
  fail: "Test failed — hover for details",
};

/** Shown while the verdict panel is open — the click closes it. */
const DISMISS_LABEL = "Hide the test result";
/** Shown once the verdict has been dismissed — the click tests again. */
const RETEST_LABEL = "Test this model again";

/** "1.4s" reads better than "1423ms" at a glance. */
function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Where the result panel sits, in viewport coordinates. The panel is
 * portalled out of the model list because that list is a scroll container
 * (`overflow-y: auto`): a child positioned inside it gets clipped at the
 * list's edges and slides under its scrollbar. Fixed positioning against
 * the button's rect is immune to both.
 */
interface PopPlacement {
  /** Distance from the viewport's right edge — keeps the panel right-aligned to the button. */
  right: number;
  top?: number;
  bottom?: number;
  maxWidth: number;
}

/** Rough tallest realistic panel (route + error prose + meta), for the flip decision. */
const POP_ESTIMATED_HEIGHT = 180;
const POP_GAP = 6;
const POP_MARGIN = 12;

/**
 * Everything about a model that changes what gets sent. A verdict is only
 * valid for the exact configuration it was produced from, so any edit to
 * these must discard it — a green check against since-changed settings
 * would be a lie.
 */
function configFingerprint(model: LLMModel): string {
  return JSON.stringify([
    model.modelKey,
    model.maxOutputTokens,
    model.supportsThinking,
    model.reasoning,
    model.extraBody,
    model.providerType,
  ]);
}

export const ModelTestButton: React.FC<{ model: LLMModel }> = ({ model }) => {
  const [state, setState] = useState<TestState>("idle");
  const [report, setReport] = useState<ProviderTestReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  // The user closed the panel by hand. Held until the pointer/focus leaves, so
  // the hover that is still sitting on the button doesn't immediately re-open
  // what was just dismissed.
  const [dismissed, setDismissed] = useState(false);
  const [placement, setPlacement] = useState<PopPlacement | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);

  const attachRoot = useCallback((element: HTMLSpanElement | null) => {
    if (element) {
      setPortalTarget((element.closest(".agw-root") as HTMLElement) ?? document.body);
    }
  }, []);

  const place = useCallback(() => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const right = Math.max(POP_MARGIN, window.innerWidth - anchor.right);
    const below = window.innerHeight - anchor.bottom - POP_GAP;
    const up = below < POP_ESTIMATED_HEIGHT && anchor.top - POP_GAP > below;
    setPlacement({
      right,
      ...(up
        ? { bottom: window.innerHeight - anchor.top + POP_GAP }
        : { top: anchor.bottom + POP_GAP }),
      maxWidth: Math.min(340, window.innerWidth - right - POP_MARGIN),
    });
  }, []);

  const show = useCallback(() => {
    place();
    setOpen(true);
  }, [place]);

  // The panel is fixed-positioned, so scrolling the model list moves the row
  // out from under it. Follow the button while open, exactly as the portalled
  // select menus do.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  const selection = `${model.providerId}:${model.modelKey}`;
  const fingerprint = configFingerprint(model);

  // Reset during render rather than in an effect — the React-documented way
  // to drop state a prop change invalidated, with no extra render pass.
  const [testedFingerprint, setTestedFingerprint] = useState(fingerprint);
  if (fingerprint !== testedFingerprint) {
    setTestedFingerprint(fingerprint);
    setState("idle");
    setReport(null);
    setFailure(null);
    setOpen(false);
    setDismissed(false);
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (state === "running") return;
    setState("running");
    setFailure(null);
    setReport(null);
    show();
    try {
      const result = await testProviderModel(selection);
      if (!alive.current) return;
      setReport(result);
      setState(result.ok ? (result.warning ? "warn" : "pass") : "fail");
    } catch (err) {
      if (!alive.current) return;
      setFailure(err instanceof Error ? err.message : String(err));
      setState("fail");
    }
  }, [selection, show, state]);

  const hasResult = report !== null || failure !== null;
  /** The panel is actually on screen (`open` alone isn't enough — see the render below). */
  const showing = open && (state === "running" || hasResult);

  /** Close the panel and keep it closed while the pointer/focus stays put. */
  const dismiss = useCallback(() => {
    setOpen(false);
    setDismissed(true);
  }, []);

  /** Leaving the control forgets the dismissal, so hovering back shows the verdict again. */
  const leave = useCallback(() => {
    if (state === "running") return;
    setOpen(false);
    setDismissed(false);
  }, [state]);

  const handleClick = useCallback(() => {
    // A verdict on screen means this click is a "close", not a "test again".
    if (showing && hasResult) {
      dismiss();
      return;
    }
    setDismissed(false);
    void run();
  }, [showing, hasResult, dismiss, run]);

  const label = showing && hasResult
    ? DISMISS_LABEL
    : dismissed && hasResult
      ? RETEST_LABEL
      : LABEL_FOR_STATE[state];

  return (
    <span
      ref={attachRoot}
      className="agw-prov-test"
      onMouseEnter={() => hasResult && !dismissed && show()}
      onMouseLeave={leave}
    >
      <button
        ref={buttonRef}
        type="button"
        className="agw-prov-icon-btn agw-prov-test-btn"
        data-state={state}
        onClick={handleClick}
        onFocus={() => hasResult && !dismissed && show()}
        onBlur={leave}
        // Escape closes the panel without spending a request — the keyboard
        // equivalent of the dismissing click.
        onKeyDown={(e) => {
          if (e.key === "Escape" && showing) {
            e.stopPropagation();
            dismiss();
          }
        }}
        disabled={state === "running"}
        aria-label={label}
        aria-expanded={hasResult ? showing : undefined}
        title={showing ? undefined : label}
      >
        <AgentIcon name={ICON_FOR_STATE[state]} size={14} />
      </button>

      {portalTarget &&
        showing &&
        placement &&
        createPortal(
          <span
            className="agw-prov-test-pop"
            role="status"
            aria-live="polite"
            style={{
              right: placement.right,
              top: placement.top,
              bottom: placement.bottom,
              maxWidth: placement.maxWidth,
            }}
          >
            {state === "running" ? (
              <span className="agw-prov-test-line">Sending a test message…</span>
            ) : failure ? (
              <span className="agw-prov-test-line">{failure}</span>
            ) : report ? (
              <>
                <span className="agw-prov-test-route">
                  <span className="agw-prov-test-shape">{report.wireShape}</span>
                  <span className="agw-prov-test-url">{report.url}</span>
                </span>

                {report.ok ? (
                  <>
                    <span className="agw-prov-test-reply">{report.snippet}</span>
                    <span className="agw-prov-test-meta">
                      {formatLatency(report.latencyMs)}
                      {report.outputTokens != null && (
                        <> · {report.inputTokens ?? 0} in / {report.outputTokens} out</>
                      )}
                      {report.reasoningRequested && (
                        <> · reasoning {report.reasoningReceived ? "received" : "missing"}</>
                      )}
                    </span>
                    {report.warning && (
                      <span className="agw-prov-test-line" data-tone="warn">
                        {report.warning}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <span className="agw-prov-test-line" data-tone="bad">
                      {report.error}
                    </span>
                    <span className="agw-prov-test-meta">
                      Failed after {formatLatency(report.latencyMs)}
                    </span>
                  </>
                )}
              </>
            ) : null}
          </span>,
          portalTarget,
        )}
    </span>
  );
};
