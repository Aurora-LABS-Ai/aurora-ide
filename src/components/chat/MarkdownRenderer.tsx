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

import React, { memo } from 'react';
import { Streamdown } from 'streamdown';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

// Custom components for Streamdown rendering - matching our theme system
const components = {
  // Code blocks - inline
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    // Check if it's a code block (has language class) or inline code
    const isCodeBlock = className?.includes('language-');
    
    if (isCodeBlock) {
      // Let Streamdown handle code blocks with its built-in syntax highlighting
      return <code className={className} {...props}>{children}</code>;
    }

    // Inline code
    return (
      <code
        className="px-1 py-0.5 rounded text-[var(--aurora-common-primary)] font-mono text-[11px]"
        style={{ background: 'var(--aurora-editor-background)' }}
        {...props}
      >
        {children}
      </code>
    );
  },

  // Paragraphs
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p 
      className="text-[13px] leading-relaxed my-1.5"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </p>
  ),

  // Headers
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 
      className="text-lg font-bold mt-3 mb-2"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 
      className="text-base font-bold mt-3 mb-1.5"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 
      className="text-sm font-semibold mt-2 mb-1"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4 
      className="text-[13px] font-semibold mt-2 mb-1"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </h4>
  ),

  // Lists
  ul: ({ children, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul 
      className="list-disc list-inside my-1.5 space-y-0.5 text-[13px]"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol 
      className="list-decimal list-inside my-1.5 space-y-0.5 text-[13px]"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li 
      className="text-[13px] leading-relaxed"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </li>
  ),

  // Links
  a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline"
      style={{ color: 'var(--aurora-common-primary)' }}
      {...props}
    >
      {children}
    </a>
  ),

  // Blockquotes
  blockquote: ({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote 
      className="border-l-2 pl-3 my-2 italic"
      style={{ 
        borderColor: 'var(--aurora-common-primary)',
        color: 'var(--aurora-chat-foreground)',
        opacity: 0.8
      }}
      {...props}
    >
      {children}
    </blockquote>
  ),

  // Horizontal rule
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr 
      className="my-3"
      style={{ borderColor: 'var(--aurora-common-border)' }}
      {...props}
    />
  ),

  // Strong/Bold
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong 
      className="font-semibold"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </strong>
  ),

  // Emphasis/Italic
  em: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <em 
      className="italic"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </em>
  ),

  // Tables
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div className="my-2 overflow-x-auto scrollbar-thin">
      <table 
        className="min-w-full text-[12px] rounded"
        style={{ border: '1px solid var(--aurora-common-border)' }}
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead 
      style={{ background: 'var(--aurora-sidebar-background)' }}
      {...props}
    >
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody 
      className="divide-y"
      style={{ borderColor: 'var(--aurora-common-border)' }}
      {...props}
    >
      {children}
    </tbody>
  ),
  tr: ({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr 
      className="hover:bg-white/5"
      {...props}
    >
      {children}
    </tr>
  ),
  th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th 
      className="px-2 py-1.5 text-left font-semibold"
      style={{ 
        color: 'var(--aurora-chat-foreground)',
        borderBottom: '1px solid var(--aurora-common-border)'
      }}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td 
      className="px-2 py-1.5"
      style={{ 
        color: 'var(--aurora-chat-foreground)',
        opacity: 0.8,
        borderBottom: '1px solid var(--aurora-common-border)'
      }}
      {...props}
    >
      {children}
    </td>
  ),

  // Delete/Strikethrough
  del: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <del 
      className="line-through"
      style={{ color: 'var(--aurora-chat-foreground)', opacity: 0.5 }}
      {...props}
    >
      {children}
    </del>
  ),
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = memo(({ content, isStreaming = false }) => {
  if (!content) return null;

  return (
    <div className="markdown-content overflow-hidden">
      <Streamdown
        isAnimating={isStreaming}
        components={components}
        shikiTheme={['github-dark', 'github-dark']}
        controls={{
          code: true,
          table: true,
        }}
      >
        {content}
      </Streamdown>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
