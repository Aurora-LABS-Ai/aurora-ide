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

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { Streamdown } from 'streamdown';
import { Copy, Check, FileCode, Terminal, FileJson, FileText, Database, Globe, Braces, Hash } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

// Language icon mapping for code blocks
const getLanguageIcon = (lang: string): React.ReactNode => {
  const iconProps = { className: 'w-3 h-3', strokeWidth: 1.5 };
  const langLower = lang.toLowerCase();
  
  switch (langLower) {
    case 'typescript':
    case 'ts':
    case 'tsx':
      return <FileCode {...iconProps} />;
    case 'javascript':
    case 'js':
    case 'jsx':
      return <Braces {...iconProps} />;
    case 'json':
      return <FileJson {...iconProps} />;
    case 'bash':
    case 'shell':
    case 'sh':
    case 'zsh':
    case 'powershell':
    case 'cmd':
      return <Terminal {...iconProps} />;
    case 'sql':
      return <Database {...iconProps} />;
    case 'html':
    case 'css':
    case 'scss':
      return <Globe {...iconProps} />;
    case 'python':
    case 'py':
      return <Hash {...iconProps} />;
    default:
      return <FileText {...iconProps} />;
  }
};

// Language display name mapping
const getLanguageDisplayName = (lang: string): string => {
  const langMap: Record<string, string> = {
    'ts': 'TypeScript',
    'tsx': 'TSX',
    'typescript': 'TypeScript',
    'js': 'JavaScript',
    'jsx': 'JSX',
    'javascript': 'JavaScript',
    'py': 'Python',
    'python': 'Python',
    'rb': 'Ruby',
    'ruby': 'Ruby',
    'rs': 'Rust',
    'rust': 'Rust',
    'go': 'Go',
    'java': 'Java',
    'cpp': 'C++',
    'c': 'C',
    'cs': 'C#',
    'csharp': 'C#',
    'php': 'PHP',
    'swift': 'Swift',
    'kt': 'Kotlin',
    'kotlin': 'Kotlin',
    'sql': 'SQL',
    'json': 'JSON',
    'yaml': 'YAML',
    'yml': 'YAML',
    'xml': 'XML',
    'html': 'HTML',
    'css': 'CSS',
    'scss': 'SCSS',
    'sass': 'Sass',
    'less': 'Less',
    'md': 'Markdown',
    'markdown': 'Markdown',
    'bash': 'Bash',
    'shell': 'Shell',
    'sh': 'Shell',
    'zsh': 'Zsh',
    'powershell': 'PowerShell',
    'ps1': 'PowerShell',
    'cmd': 'CMD',
    'dockerfile': 'Dockerfile',
    'docker': 'Docker',
    'toml': 'TOML',
    'ini': 'INI',
    'env': 'ENV',
    'graphql': 'GraphQL',
    'gql': 'GraphQL',
  };
  return langMap[lang.toLowerCase()] || lang.toUpperCase();
};

// Copy button component with feedback
const CopyButton: React.FC<{ text: string; size?: 'sm' | 'md' }> = ({ text, size = 'sm' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [text]);

  const iconSize = size === 'sm' ? 'w-3 h-3' : 'w-3.5 h-3.5';
  const padding = size === 'sm' ? 'p-1' : 'p-1.5';

  return (
    <button
      onClick={handleCopy}
      className={`${padding} rounded transition-all duration-200 flex items-center gap-1`}
      style={{
        background: copied ? 'var(--aurora-common-success)' : 'transparent',
        color: copied ? 'var(--aurora-common-success-foreground)' : 'var(--aurora-editor-foreground)',
        opacity: copied ? 1 : 0.5,
      }}
      onMouseEnter={(e) => { if (!copied) e.currentTarget.style.opacity = '0.9'; }}
      onMouseLeave={(e) => { if (!copied) e.currentTarget.style.opacity = '0.5'; }}
      title={copied ? 'Copied!' : 'Copy code'}
    >
      {copied ? (
        <>
          <Check className={iconSize} />
          {size === 'md' && <span className="text-[10px] font-medium">Copied</span>}
        </>
      ) : (
        <Copy className={iconSize} />
      )}
    </button>
  );
};

// Code block wrapper with header, language tag, and copy button
const CodeBlockWrapper: React.FC<{ 
  children: React.ReactNode; 
  language?: string;
  rawCode?: string;
}> = ({ children, language, rawCode }) => {
  const codeRef = useRef<HTMLDivElement>(null);
  const [codeText, setCodeText] = useState(rawCode || '');

  useEffect(() => {
    if (!rawCode && codeRef.current) {
      // Extract text content from the code block
      const text = codeRef.current.textContent || '';
      const rafId = window.requestAnimationFrame(() => {
        setCodeText(text);
      });
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [rawCode, children]);

  const hasLanguage = language && language !== 'text' && language !== 'plaintext';

  return (
    <div 
      className="group/code relative my-3 rounded-lg overflow-hidden"
      style={{ 
        background: 'var(--aurora-chat-code-block, var(--aurora-editor-background))',
        border: '1px solid var(--aurora-common-border)',
      }}
    >
      {/* Header bar with language and copy button */}
      <div 
        className="flex items-center justify-between px-3 py-1.5 border-b"
        style={{ 
          background: 'rgba(255, 255, 255, 0.03)',
          borderColor: 'var(--aurora-common-border)',
        }}
      >
        <div className="flex items-center gap-1.5">
          {hasLanguage && (
            <>
              <span style={{ color: 'var(--aurora-common-primary)', opacity: 0.8 }}>
                {getLanguageIcon(language)}
              </span>
              <span 
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: 'var(--aurora-editor-foreground)', opacity: 0.6 }}
              >
                {getLanguageDisplayName(language)}
              </span>
            </>
          )}
        </div>
        <CopyButton text={codeText || rawCode || ''} size="sm" />
      </div>
      
      {/* Code content */}
      <div ref={codeRef} className="overflow-x-auto scrollbar-thin">
        {children}
      </div>
    </div>
  );
};

// Custom components for Streamdown rendering - matching our theme system
const components = {
  // Pre blocks - wrapped with CodeBlockWrapper
  pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
    // Extract language from className of nested code element
    let language = '';
    let rawCode = '';
    
    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.props?.className) {
        const match = child.props.className.match(/language-(\w+)/);
        if (match) language = match[1];
        // Try to get raw code from children
        if (typeof child.props.children === 'string') {
          rawCode = child.props.children;
        }
      }
    });

    return (
      <CodeBlockWrapper language={language} rawCode={rawCode}>
        <pre
          className="p-3 text-[12px] leading-relaxed m-0"
          style={{
            background: 'transparent',
            fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Monaco, monospace",
          }}
          {...props}
        >
          {children}
        </pre>
      </CodeBlockWrapper>
    );
  },

  // Code blocks - inline and block
  code: ({ children, className, ...props }: React.HTMLAttributes<HTMLElement>) => {
    const isCodeBlock = className?.includes('language-');
    
    if (isCodeBlock) {
      return (
        <code 
          className={className} 
          style={{
            fontFamily: "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: '12px',
            lineHeight: '1.6',
            color: 'var(--aurora-editor-foreground)',
          }}
          {...props}
        >
          {children}
        </code>
      );
    }

    // Inline code - styled nicely
    return (
      <code
        className="px-1.5 py-0.5 rounded font-mono text-[11px] mx-0.5"
        style={{ 
          background: 'var(--aurora-chat-code-block, var(--aurora-editor-background))',
          color: 'var(--aurora-common-primary)',
          border: '1px solid var(--aurora-common-border)',
        }}
        {...props}
      >
        {children}
      </code>
    );
  },

  // Paragraphs
  p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p 
      className="text-[13px] leading-relaxed my-2"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </p>
  ),

  // Headers with accent styling
  h1: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h1 
      className="text-lg font-bold mt-4 mb-2 pb-1 border-b"
      style={{ 
        color: 'var(--aurora-chat-foreground)',
        borderColor: 'var(--aurora-common-border)',
      }}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 
      className="text-base font-bold mt-4 mb-2"
      style={{ color: 'var(--aurora-chat-foreground)' }}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3 
      className="text-sm font-semibold mt-3 mb-1.5"
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

  // Lists with better styling
  ul: ({ children, style, className, ...props }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul 
      className={["my-2 space-y-1 text-[13px]", className].filter(Boolean).join(" ")}
      {...props}
      style={{
        ...(style || {}),
        color: 'var(--aurora-chat-foreground)',
        listStyleType: 'disc',
        paddingLeft: '1.25rem',
        listStylePosition: 'outside',
      }}
    >
      {children}
    </ul>
  ),
  ol: ({ children, style, className, ...props }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol 
      className={["my-2 space-y-1 text-[13px]", className].filter(Boolean).join(" ")}
      {...props}
      style={{
        ...(style || {}),
        color: 'var(--aurora-chat-foreground)',
        listStyleType: 'decimal',
        paddingLeft: '1.25rem',
        listStylePosition: 'outside',
      }}
    >
      {children}
    </ol>
  ),
  li: ({ children, style, className, ...props }: React.HTMLAttributes<HTMLLIElement>) => (
    <li 
      className={["text-[13px] leading-relaxed", className].filter(Boolean).join(" ")}
      {...props}
      style={{ 
        ...(style || {}),
        color: 'var(--aurora-chat-foreground)',
      }}
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
      className="hover:underline transition-colors"
      style={{ color: 'var(--aurora-common-primary)' }}
      {...props}
    >
      {children}
    </a>
  ),

  // Blockquotes with accent border
  blockquote: ({ children, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote 
      className="border-l-3 pl-4 my-3 py-1 rounded-r"
      style={{ 
        borderLeftWidth: '3px',
        borderColor: 'var(--aurora-common-primary)',
        background: 'rgba(var(--aurora-common-primary-rgb, 96, 165, 250), 0.05)',
      }}
      {...props}
    >
      <div style={{ color: 'var(--aurora-chat-foreground)', opacity: 0.85 }}>
        {children}
      </div>
    </blockquote>
  ),

  // Horizontal rule
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr 
      className="my-4 border-0 h-px"
      style={{ background: 'var(--aurora-common-border)' }}
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

  // Tables - professionally styled with zebra striping
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div 
      className="my-4 overflow-x-auto scrollbar-thin rounded-lg"
      style={{ border: '1px solid var(--aurora-common-border)' }}
    >
      <table 
        className="min-w-full text-[12px] border-collapse"
        style={{ background: 'var(--aurora-sidebar-background)' }}
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead 
      style={{ 
        background: 'var(--aurora-chat-surface, rgba(255, 255, 255, 0.05))',
      }}
      {...props}
    >
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody className="divide-y" style={{ borderColor: 'var(--aurora-common-border)' }} {...props}>
      {children}
    </tbody>
  ),
  tr: ({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr 
      className="transition-colors hover:bg-sidebar-item-hover even:bg-input/30"
      {...props}
    >
      {children}
    </tr>
  ),
  th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th 
      className="px-4 py-2.5 text-left font-semibold text-[11px] uppercase tracking-wider"
      style={{ 
        color: 'var(--aurora-chat-foreground)',
        borderBottom: '2px solid var(--aurora-common-border)',
      }}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td 
      className="px-4 py-2.5"
      style={{ 
        color: 'var(--aurora-chat-foreground)',
        opacity: 0.9,
        borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
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

  // Images
  img: ({ src, alt, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) => (
    <img
      src={src}
      alt={alt}
      className="max-w-full h-auto rounded-lg my-2"
      style={{ border: '1px solid var(--aurora-common-border)' }}
      {...props}
    />
  ),
};

// Streaming cursor component - slim white blinking cursor
const StreamingCursor: React.FC = () => (
  <span 
    className="inline-block animate-cursor-blink ml-px align-baseline text-[11px] font-light"
    style={{ color: 'var(--aurora-common-primary)' }}
    aria-hidden="true"
  >
    |
  </span>
);

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
      {isStreaming && <StreamingCursor />}
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';
