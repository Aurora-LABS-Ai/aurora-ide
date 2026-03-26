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

import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import mermaid from 'mermaid';
import { useThemeStore } from '../../store/useThemeStore';

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

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
    <div className={`markdown-preview max-w-none ${className}`} ref={mermaidContainerRef} style={{ color: 'var(--aurora-common-text-secondary)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks with syntax highlighting
          code({ inline, className, children }: any) {
            const match = /language-(\w+)/.exec(className || '');
            const language = match ? match[1] : '';
            
            if (!inline && language) {
              return (
                <SyntaxHighlighter
                  language={language}
                  style={syntaxTheme}
                  customStyle={{
                    background: 'var(--aurora-editor-background)',
                    margin: '0',
                    borderRadius: '0.5rem',
                    fontSize: '13px',
                  }}
                  codeTagProps={{
                    style: {
                      color: 'var(--aurora-common-text-primary)',
                      fontFamily: "'JetBrains Mono', monospace",
                    },
                  }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            }
            
            if (inline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-input text-[13px]"
                  style={{ color: 'var(--aurora-common-text-primary)', fontFamily: "'JetBrains Mono', monospace" }}
                >
                  {children}
                </code>
              );
            }
            
            return (
              <code
                className="block p-3 bg-input rounded text-[13px]"
                style={{ color: 'var(--aurora-common-text-primary)', fontFamily: "'JetBrains Mono', monospace" }}
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
