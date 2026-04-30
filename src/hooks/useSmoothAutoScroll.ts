import { useCallback, useEffect, useRef } from "react";

interface UseSmoothAutoScrollOptions {
  bottomThreshold?: number;
  initialScrollBehavior?: ScrollBehavior;
  isStreaming: boolean;
  streamingFollowLerp?: number;
}

interface SmoothAutoScrollRefs {
  bottomRef: React.RefObject<HTMLDivElement>;
  containerRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
}

interface UseSmoothAutoScrollResult extends SmoothAutoScrollRefs {
  isNearBottomRef: React.MutableRefObject<boolean>;
  jumpToBottom: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

const DEFAULT_BOTTOM_THRESHOLD = 120;
const DEFAULT_STREAMING_LERP = 0.22;

export function useSmoothAutoScroll(
  options: UseSmoothAutoScrollOptions,
): UseSmoothAutoScrollResult {
  const {
    isStreaming,
    bottomThreshold = DEFAULT_BOTTOM_THRESHOLD,
    initialScrollBehavior = "auto",
    streamingFollowLerp = DEFAULT_STREAMING_LERP,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const isNearBottomRef = useRef(true);
  const previousHeightRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);

  const cancelFollowAnimation = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
  }, []);

  const getDistanceFromBottom = useCallback(
    (element: HTMLDivElement): number => {
      return element.scrollHeight - (element.scrollTop + element.clientHeight);
    },
    [],
  );

  const updateNearBottomState = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    isNearBottomRef.current =
      getDistanceFromBottom(container) <= bottomThreshold;
  }, [bottomThreshold, getDistanceFromBottom]);

  const animateFollowToBottom = useCallback(() => {
    const step = () => {
      const container = containerRef.current;
      if (!container) {
        animationFrameRef.current = null;
        return;
      }

      const target = container.scrollHeight - container.clientHeight;
      const next =
        container.scrollTop +
        (target - container.scrollTop) * streamingFollowLerp;
      const remaining = Math.abs(target - container.scrollTop);

      if (remaining <= 1) {
        container.scrollTop = target;
        animationFrameRef.current = null;
        return;
      }

      container.scrollTop = next;
      animationFrameRef.current = requestAnimationFrame(step);
    };

    step();
  }, [streamingFollowLerp]);

  const startFollowAnimation = useCallback(() => {
    cancelFollowAnimation();
    animationFrameRef.current = requestAnimationFrame(animateFollowToBottom);
  }, [animateFollowToBottom, cancelFollowAnimation]);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const container = containerRef.current;
      const bottom = bottomRef.current;
      if (!container || !bottom) return;

      if (behavior === "auto") {
        cancelFollowAnimation();
        container.scrollTop = container.scrollHeight;
        return;
      }

      bottom.scrollIntoView({ behavior, block: "end" });
    },
    [cancelFollowAnimation],
  );

  const jumpToBottom = useCallback(() => {
    scrollToBottom("auto");
  }, [scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    previousHeightRef.current = container.scrollHeight;
    updateNearBottomState();

    const handleScroll = () => {
      updateNearBottomState();
      if (!isNearBottomRef.current) {
        cancelFollowAnimation();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [cancelFollowAnimation, updateNearBottomState]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    previousHeightRef.current = container.scrollHeight;

    const observer = new ResizeObserver(() => {
      const currentHeight = container.scrollHeight;
      const grew = currentHeight > previousHeightRef.current;

      // Only auto-follow growth while the assistant is actively streaming new
      // tokens. When streaming has stopped, growth comes from the user
      // expanding a thinking dropdown / tool card / etc. — those expansions
      // must NEVER yank the viewport. The user is reading, not asking us to
      // chase the bottom.
      if (grew && isNearBottomRef.current && isStreaming) {
        startFollowAnimation();
      }

      previousHeightRef.current = currentHeight;
    });

    observer.observe(content);

    return () => {
      observer.disconnect();
    };
  }, [isStreaming, startFollowAnimation]);

  useEffect(() => {
    if (initialScrollBehavior === "auto") {
      jumpToBottom();
    } else {
      scrollToBottom(initialScrollBehavior);
    }
  }, [initialScrollBehavior, jumpToBottom, scrollToBottom]);

  useEffect(() => {
    if (!isStreaming) {
      cancelFollowAnimation();
      return;
    }

    if (isNearBottomRef.current) {
      startFollowAnimation();
    }

    return () => {
      cancelFollowAnimation();
    };
  }, [cancelFollowAnimation, isStreaming, startFollowAnimation]);

  useEffect(() => {
    return () => {
      cancelFollowAnimation();
    };
  }, [cancelFollowAnimation]);

  return {
    containerRef,
    contentRef,
    bottomRef,
    isNearBottomRef,
    scrollToBottom,
    jumpToBottom,
  };
}

export default useSmoothAutoScroll;
