/**
 * THEME ARCHITECTURE NOTICE:
 * 
 * This project uses a centralized theme system. DO NOT use hardcoded colors.
 * 
 * Instead of:
 *   - Hardcoded hex values: #ff0000, #1a1a1a
 *   - Hardcoded RGB values: rgb(255, 0, 0)
 *   - Tailwind arbitrary colors: bg-[#1a1a1a], text-[#ff0000]
 * 
 * Use theme tokens via CSS variables:
 *   - CSS: var(--aurora-{category}-{token})
 *   - Tailwind: bg-[var(--aurora-editor-background)]
 *   - Component styles: style={{ background: 'var(--aurora-sidebar-background)' }}
 * 
 * Available categories: editor, sidebar, chat, terminal, statusBar, titleBar, common
 * 
 * See: DOCS/theme-dev.md for full token reference
 * See: src/types/theme.ts for TypeScript interfaces
 * See: src/services/theme-service.ts for theme utilities
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';
import { Check, Copy } from 'lucide-react';
import { useThemeStore } from '../../store/useThemeStore';
import { writeClipboardText } from '../../lib/clipboard';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

/**
 * Code block with a hover copy button (preview-only chrome).
 *
 * Lives inside the markdown preview render path so it never appears in raw
 * editor mode. Button stays out of the way at low opacity until the block is
 * hovered, then briefly flips to a check icon on copy for tactile feedback.
 */
const CopyableCodeBlock: React.FC<{
  code: string;
  language: string;
  syntaxTheme: typeof vscDarkPlus;
}> = ({ code, language, syntaxTheme }) => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(async () => {
    const ok = await writeClipboardText(code);
    if (!ok) {
      console.error('[MarkdownPreview] Failed to copy code block to clipboard.');
      return;
    }
    setCopied(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [code]);

  return (
    <div className="group relative my-3">
      <button
        type="button"
        onClick={handleCopy}
        title={copied ? 'Copied' : `Copy ${language || 'code'}`}
        aria-label={copied ? 'Copied' : 'Copy code block'}
        className="absolute top-2 right-2 z-[2] flex h-7 w-7 items-center justify-center rounded-md opacity-0 transition-all duration-150 group-hover:opacity-100 focus-visible:opacity-100"
        style={{
          backgroundColor:
            'color-mix(in srgb, var(--aurora-editor-background) 78%, var(--aurora-common-border) 22%)',
          border:
            '1px solid color-mix(in srgb, var(--aurora-common-border) 60%, transparent)',
          color: copied
            ? 'var(--aurora-common-primary)'
            : 'var(--aurora-common-text-secondary)',
          backdropFilter: 'blur(2px)',
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      {language ? (
        <span
          aria-hidden
          className="absolute top-2 left-3 z-[2] select-none text-[10px] uppercase tracking-wider opacity-60"
          style={{ color: 'var(--aurora-common-muted-foreground)' }}
        >
          {language}
        </span>
      ) : null}
      <SyntaxHighlighter
        language={language}
        style={syntaxTheme}
        customStyle={{
          background: 'var(--aurora-editor-background)',
          margin: 0,
          borderRadius: '0.5rem',
          padding: language ? '1.75rem 1rem 1rem 1rem' : '1rem',
          fontSize: '13px',
        }}
        codeTagProps={{
          style: {
            color: 'var(--aurora-common-text-primary)',
            fontFamily: "'JetBrains Mono', monospace",
          },
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};

export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ content, className = '' }) => {
  const mermaidContainerRef = useRef<HTMLDivElement>(null);
  const activeThemeType = useThemeStore((state) =>
    state.themes.find((theme) => theme.id === state.activeThemeId)?.type ?? 'dark'
  );
  const syntaxTheme = activeThemeType === 'light' ? oneLight : vscDarkPlus;

  // Initialize Mermaid
  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      theme: activeThemeType === 'light' ? 'default' : 'dark',
      securityLevel: 'loose',
    });
  }, [activeThemeType]);

  // Render Mermaid diagrams
  useEffect(() => {
    if (!mermaidContainerRef.current) return;

    const container = mermaidContainerRef.current;
    const mermaidBlocks = container.querySelectorAll('.mermaid');

    mermaidBlocks.forEach(async (block) => {
      const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
      const code = block.textContent || '';
      
      try {
        const { svg } = await mermaid.render(id, code);
        block.innerHTML = svg;
        block.classList.add('mermaid-rendered');
      } catch (error) {
        console.error('Mermaid rendering error:', error);
        block.innerHTML = `<div class="text-error text-xs p-2">Error rendering diagram</div>`;
      }
    });
  }, [activeThemeType, content]);

  return (
    <div
      className={`markdown-preview select-text max-w-none ${className}`}
      ref={mermaidContainerRef}
      style={{
        color: 'var(--aurora-common-text-secondary)',
        // Belt-and-suspenders: the global `body { user-select: none }` rule
        // bleeds into descendants under various Tailwind/preflight resets.
        // The `.select-text` class above is already wired in `index.css`
        // to flip selection back on, but we set it inline as well so this
        // wrapper survives any future global CSS changes.
        WebkitUserSelect: 'text',
        userSelect: 'text',
      }}
      // The body has `cursor: default` so `text` cursor on the readable
      // surface signals to users that they CAN select. Small but tells
      // them at a glance that this view supports manual copy.
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // react-markdown 10.x removed the `inline` prop on the `code`
          // component. We now distinguish block vs inline by overriding
          // BOTH renderers:
          //
          //   - `pre`  → invoked only for fenced code blocks. We unwrap
          //     the inner `<code>` element to harvest its className and
          //     text, then render the full CopyableCodeBlock chrome
          //     (hover copy button, language tag, syntax highlighting).
          //     This sits at block scope, so the copy chrome only
          //     appears on real code blocks.
          //
          //   - `code` → after the `pre` override, every code element
          //     remaining in the tree is inline (e.g. `code` spans
          //     inside paragraphs and list items). Render as a small
          //     pill so we never put a <div> inside a <p>.
          pre({ children }: any) {
            if (
              React.isValidElement(children) &&
              (children as React.ReactElement<{
                className?: string;
                children?: React.ReactNode;
              }>).props
            ) {
              const codeProps = (children as React.ReactElement<{
                className?: string;
                children?: React.ReactNode;
              }>).props;
              const match = /language-(\w+)/.exec(codeProps.className || '');
              const language = match ? match[1] : '';
              const codeText = String(codeProps.children ?? '').replace(/\n$/, '');
              return (
                <CopyableCodeBlock
                  code={codeText}
                  language={language}
                  syntaxTheme={syntaxTheme}
                />
              );
            }
            return <pre>{children}</pre>;
          },

          code({ className, children }: any) {
            return (
              <code
                className={`px-1.5 py-0.5 rounded bg-input text-[13px] ${className || ''}`.trim()}
                style={{
                  color: 'var(--aurora-common-text-primary)',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {children}
              </code>
            );
          },
          
          // Headings
          h1: ({ children }: any) => (
            <h1
              className="text-2xl font-bold mt-6 mb-3 pb-2 border-b"
              style={{ color: 'var(--aurora-common-text-primary)', borderColor: 'var(--aurora-common-border)' }}
            >
              {children}
            </h1>
          ),
          h2: ({ children }: any) => (
            <h2
              className="text-xl font-bold mt-5 mb-3 pb-1 border-b"
              style={{ color: 'var(--aurora-common-text-primary)', borderColor: 'var(--aurora-common-border)' }}
            >
              {children}
            </h2>
          ),
          h3: ({ children }: any) => (
            <h3
              className="text-lg font-semibold mt-4 mb-2"
              style={{ color: 'var(--aurora-common-text-primary)' }}
            >
              {children}
            </h3>
          ),
          h4: ({ children }: any) => (
            <h4
              className="text-base font-semibold mt-3 mb-2"
              style={{ color: 'var(--aurora-common-text-primary)' }}
            >
              {children}
            </h4>
          ),
          h5: ({ children }: any) => (
            <h5
              className="text-sm font-semibold mt-2 mb-1"
              style={{ color: 'var(--aurora-common-text-primary)' }}
            >
              {children}
            </h5>
          ),
          h6: ({ children }: any) => (
            <h6
              className="text-xs font-medium mt-2 mb-1"
              style={{ color: 'var(--aurora-common-muted-foreground)' }}
            >
              {children}
            </h6>
          ),
          
          // Paragraphs
          p: ({ children }: any) => (
            <p className="mb-4 leading-7">{children}</p>
          ),
          
          // Links
          a: ({ href, children }: any) => (
            <a
              href={href}
              className="underline hover:text-primary transition-colors"
              style={{ color: 'var(--aurora-common-primary)' }}
            >
              {children}
            </a>
          ),
          
          // Lists
          ul: ({ children }: any) => (
            <ul className="list-disc pl-6 mb-4 space-y-1">{children}</ul>
          ),
          ol: ({ children }: any) => (
            <ol className="list-decimal pl-6 mb-4 space-y-1">{children}</ol>
          ),
          li: ({ children }: any) => (
            <li className="leading-7">{children}</li>
          ),
          
          // Blockquotes
          blockquote: ({ children }: any) => (
            <blockquote
              className="border-l-4 pl-4 py-1 mb-4 text-sm"
              style={{ borderColor: 'var(--aurora-common-border)', color: 'var(--aurora-common-muted-foreground)' }}
            >
              {children}
            </blockquote>
          ),
          
          // Tables
          table: ({ children }: any) => (
            <div className="overflow-x-auto mb-4">
              <table className="min-w-full border-collapse text-sm">
                {children}
              </table>
            </div>
          ),
          thead: ({ children }: any) => (
            <thead
              className="border-b-2 font-medium"
              style={{ borderColor: 'var(--aurora-common-border)', color: 'var(--aurora-common-text-primary)' }}
            >
              {children}
            </thead>
          ),
          tbody: ({ children }: any) => <tbody>{children}</tbody>,
          tr: ({ children }: any) => (
            <tr className="border-b" style={{ borderColor: 'var(--aurora-common-border)' }}>
              {children}
            </tr>
          ),
          th: ({ children }: any) => (
            <th className="px-3 py-2 text-left">{children}</th>
          ),
          td: ({ children }: any) => (
            <td className="px-3 py-2">{children}</td>
          ),
          
          // Horizontal rule
          hr: () => (
            <hr
              className="my-6"
              style={{ borderColor: 'var(--aurora-common-border)' }}
            />
          ),
          
          // Italic
          em: ({ children, ...props }: any) => (
            <em className="italic" {...props}>{children}</em>
          ),
          
          // Strong/Bold
          strong: ({ children, ...props }: any) => (
            <strong className="font-semibold" style={{ color: 'var(--aurora-common-text-primary)' }} {...props}>
              {children}
            </strong>
          ),
          
          // Mermaid diagram blocks
          div: ({ className, children, ...props }: any) => {
            if (className === 'mermaid') {
              return (
                <div className="mermaid my-4 p-4 bg-input/30 rounded-lg overflow-auto">
                  {children}
                </div>
              );
            }
            return <div className={className} {...props}>{children}</div>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};
