/**
 * StreamingText - A component that displays text with a smooth typing animation
 * 
 * Used for streaming LLM responses with a natural typing effect and blinking cursor.
 * Unlike animation-based typing components, this is driven by external content updates
 * (from streaming API responses) and smoothly animates the display of new characters.
 */

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { cn } from '../../lib/cn';

interface StreamingTextProps {
  /** The full content to display (updated externally as tokens arrive) */
  content: string;
  /** Whether streaming is currently active */
  isStreaming: boolean;
  /** Speed of character reveal in milliseconds (default: 10ms for smooth 100 chars/sec) */
  charRevealSpeed?: number;
  /** Custom className for the container */
  className?: string;
  /** Whether to show the blinking cursor */
  showCursor?: boolean;
  /** Cursor style */
  cursorStyle?: 'line' | 'block' | 'underscore';
  /** Callback when all content has been revealed */
  onComplete?: () => void;
  /** Render function for the content (e.g., markdown renderer) */
  renderContent?: (text: string) => React.ReactNode;
}

export const StreamingText: React.FC<StreamingTextProps> = ({
  content,
  isStreaming,
  charRevealSpeed = 8,
  className,
  showCursor = true,
  cursorStyle = 'line',
  onComplete,
  renderContent,
}) => {
  // Track how many characters are currently displayed
  const [displayedLength, setDisplayedLength] = useState(0);
  const animationRef = useRef<number | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const contentLengthRef = useRef(0);

  // Get cursor character based on style
  const cursorChar = useMemo(() => {
    switch (cursorStyle) {
      case 'block': return '▌';
      case 'underscore': return '_';
      case 'line':
      default: return '│';
    }
  }, [cursorStyle]);

  // Animate character reveal using RAF for smooth 60fps animation
  const animate = useCallback((timestamp: number) => {
    const elapsed = timestamp - lastUpdateRef.current;
    const targetLength = contentLengthRef.current;
    
    setDisplayedLength(prev => {
      if (prev >= targetLength) {
        // All caught up - stop animation
        animationRef.current = null;
        return prev;
      }

      // Calculate how many chars to reveal based on elapsed time
      // This creates smooth animation even with variable frame times
      const charsToReveal = Math.max(1, Math.floor(elapsed / charRevealSpeed));
      const newLength = Math.min(prev + charsToReveal, targetLength);
      
      lastUpdateRef.current = timestamp;
      return newLength;
    });

    // Continue animation if not caught up
    if (animationRef.current !== null) {
      animationRef.current = requestAnimationFrame(animate);
    }
  }, [charRevealSpeed]);

  // Start/update animation when content changes
  useEffect(() => {
    contentLengthRef.current = content.length;

    // If we're behind, start catching up
    if (displayedLength < content.length) {
      if (!animationRef.current) {
        lastUpdateRef.current = performance.now();
        animationRef.current = requestAnimationFrame(animate);
      }
    }

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
    };
  }, [content, displayedLength, animate]);

  // Call onComplete when streaming ends and all content is revealed
  useEffect(() => {
    if (!isStreaming && displayedLength >= content.length && content.length > 0) {
      onComplete?.();
    }
  }, [isStreaming, displayedLength, content.length, onComplete]);

  // When streaming ends, immediately show all remaining content
  useEffect(() => {
    if (!isStreaming && displayedLength < content.length) {
      // Give a brief moment for final animation, then show all
      const timeout = setTimeout(() => {
        setDisplayedLength(content.length);
      }, 100);
      return () => clearTimeout(timeout);
    }
  }, [isStreaming, displayedLength, content.length]);

  // The text to display (up to displayedLength characters)
  const displayedText = useMemo(() => {
    return content.slice(0, displayedLength);
  }, [content, displayedLength]);

  // Whether to show the cursor (streaming active and not fully revealed)
  const shouldShowCursor = showCursor && isStreaming;

  // Render the content
  const renderedContent = renderContent ? renderContent(displayedText) : displayedText;

  return (
    <span className={cn('streaming-text', className)}>
      {renderedContent}
      {shouldShowCursor && (
        <span 
          className="inline-block animate-cursor-blink ml-0.5 text-primary font-normal"
          aria-hidden="true"
        >
          {cursorChar}
        </span>
      )}
    </span>
  );
};

/**
 * Hook for managing streaming text state
 * Use this when you need more control over the streaming process
 */
export function useStreamingText(initialContent = '') {
  const [content, setContent] = useState(initialContent);
  const [isStreaming, setIsStreaming] = useState(false);

  const startStreaming = useCallback(() => {
    setIsStreaming(true);
  }, []);

  const appendContent = useCallback((text: string) => {
    setContent(prev => prev + text);
  }, []);

  const setFullContent = useCallback((text: string) => {
    setContent(text);
  }, []);

  const stopStreaming = useCallback(() => {
    setIsStreaming(false);
  }, []);

  const reset = useCallback(() => {
    setContent('');
    setIsStreaming(false);
  }, []);

  return {
    content,
    isStreaming,
    startStreaming,
    appendContent,
    setFullContent,
    stopStreaming,
    reset,
  };
}

export default StreamingText;

