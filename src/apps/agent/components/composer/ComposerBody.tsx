import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Animate the space occupied by attachments and text, without scaling either.
 * The content keeps its natural height so native editing and the ghost's line
 * reservation can run independently of the shell's current animation frame.
 */
export function ComposerBody({ children }: { children: ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) return;

    let previousHeight: number | null = null;
    const measure = () => {
      const height = content.getBoundingClientRect().height;
      if (height === previousHeight) return;

      if (previousHeight !== null) {
        // A wrapped line responds quickly; an attachment gets a little longer
        // to open. CSS retargets from the current height when input interrupts.
        const duration = Math.min(220, 130 + Math.abs(height - previousHeight) * 0.7);
        body.style.setProperty("--agw-composer-resize-duration", `${duration}ms`);
      }
      body.style.height = `${height}px`;
      previousHeight = height;
    };

    // Mount at the real height before paint. Only subsequent changes animate.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={bodyRef} className="agw-composer-body">
      <div ref={contentRef} className="agw-composer-body-content">
        {children}
      </div>
    </div>
  );
}
