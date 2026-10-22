import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Animate the space occupied by attachments, without scaling them.
 * The content keeps its natural height so native editing and the ghost's line
 * reservation can run independently of the shell's current animation frame.
 *
 * Only an attachment change eases. A wrapped line of text grows the box at
 * once, the way every editor does: easing each line made the composer lag
 * the caret by a frame or two on every Enter, and in a chat the transcript's
 * own auto-scroll was answering the same keystroke a second time.
 */
export function ComposerBody({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) return;

    let previousHeight: number | null = null;
    let previousEditorHeight: number | null = null;
    let frame: number | null = null;
    const measure = () => {
      const height = content.getBoundingClientRect().height;
      const editor = content.querySelector<HTMLElement>(".agw-ce-wrap");
      const editorHeight = editor ? editor.getBoundingClientRect().height : 0;
      if (height === previousHeight) {
        previousEditorHeight = editorHeight;
        return;
      }

      if (previousHeight !== null) {
        const delta = Math.abs(height - previousHeight);
        const editorDelta =
          previousEditorHeight === null ? 0 : Math.abs(editorHeight - previousEditorHeight);
        // The editor alone changed: a line wrapped or unwrapped. Instant.
        // Anything else is an attachment row opening or closing: ease, a
        // little longer for a bigger opening. CSS retargets from the current
        // height when input interrupts.
        const textOnly = Math.abs(delta - editorDelta) < 1;
        const duration = textOnly ? 0 : Math.min(220, 130 + delta * 0.7);
        body.style.setProperty("--agw-composer-resize-duration", `${duration}ms`);
      }
      body.style.height = `${height}px`;
      previousHeight = height;
      previousEditorHeight = editorHeight;
    };

    measureRef.current = measure;
    // A child resize can change the observed home column through this body's
    // height. Do not resize that ancestor during ResizeObserver delivery.
    const observer = new ResizeObserver(() => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
      measureRef.current = null;
    };
  }, []);

  // Mount and normal editor renders still size before paint, without making
  // typing wait for the observer's deferred pass. Only attachments animate.
  useLayoutEffect(() => {
    measureRef.current?.();
  });

  return (
    <div ref={bodyRef} className="agw-composer-body">
      <div ref={contentRef} className="agw-composer-body-content">
        {children}
      </div>
    </div>
  );
}
