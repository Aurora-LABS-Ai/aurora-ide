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

import React, { memo, useState, useCallback, useRef, useEffect } from "react";
import { Streamdown } from "streamdown";
import {
  Copy,
  Check,
  FileCode,
  Terminal,
  FileJson,
  FileText,
  Database,
  Globe,
  Braces,
  Hash,
} from "lucide-react";
import { StreamingDotMatrix } from "../ui/StreamingDotMatrix";
import { useThemeStore } from "../../store/useThemeStore";

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

// Language icon mapping for code blocks
const getLanguageIcon = (lang: string): React.ReactNode => {
  const iconProps = { className: "w-3 h-3", strokeWidth: 1.5 };
  const langLower = lang.toLowerCase();

  switch (langLower) {
    case "typescript":
    case "ts":
    case "tsx":
      return <FileCode {...iconProps} />;
    case "javascript":
    case "js":
    case "jsx":
      return <Braces {...iconProps} />;
    case "json":
      return <FileJson {...iconProps} />;
    case "bash":
    case "shell":
    case "sh":
    case "zsh":
    case "powershell":
    case "cmd":
      return <Terminal {...iconProps} />;
    case "sql":
      return <Database {...iconProps} />;
    case "html":
    case "css":
    case "scss":
      return <Globe {...iconProps} />;
    case "python":
    case "py":
      return <Hash {...iconProps} />;
    default:
      return <FileText {...iconProps} />;
  }
};

// Language display name mapping
const getLanguageDisplayName = (lang: string): string => {
  const langMap: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TSX",
    typescript: "TypeScript",
    js: "JavaScript",
    jsx: "JSX",
    javascript: "JavaScript",
    py: "Python",
    python: "Python",
    rb: "Ruby",
    ruby: "Ruby",
    rs: "Rust",
    rust: "Rust",
    go: "Go",
    java: "Java",
    cpp: "C++",
    c: "C",
    cs: "C#",
    csharp: "C#",
    php: "PHP",
    swift: "Swift",
    kt: "Kotlin",
    kotlin: "Kotlin",
    sql: "SQL",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    xml: "XML",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    sass: "Sass",
    less: "Less",
    md: "Markdown",
    markdown: "Markdown",
    bash: "Bash",
    shell: "Shell",
    sh: "Shell",
    zsh: "Zsh",
    powershell: "PowerShell",
    ps1: "PowerShell",
    cmd: "CMD",
    dockerfile: "Dockerfile",
    docker: "Docker",
    toml: "TOML",
    ini: "INI",
    env: "ENV",
    graphql: "GraphQL",
    gql: "GraphQL",
  };
  return langMap[lang.toLowerCase()] || lang.toUpperCase();
};

// Copy button component with feedback
const CopyButton: React.FC<{ text: string; size?: "sm" | "md" }> = ({
  text,
  size = "sm",
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    },
    [text],
  );

  const iconSize = size === "sm" ? "w-3 h-3" : "w-3.5 h-3.5";
  const padding = size === "sm" ? "p-1" : "p-1.5";

  return (
    <button
      onClick={handleCopy}
      className={`${padding} rounded transition-all duration-200 flex items-center gap-1`}
      style={{
        background: copied ? "var(--aurora-common-success)" : "transparent",
        color: copied
          ? "var(--aurora-common-success-foreground)"
          : "var(--aurora-editor-foreground)",
        opacity: copied ? 1 : 0.5,
      }}
      onMouseEnter={(e) => {
        if (!copied) e.currentTarget.style.opacity = "0.9";
      }}
      onMouseLeave={(e) => {
        if (!copied) e.currentTarget.style.opacity = "0.5";
      }}
      title={copied ? "Copied!" : "Copy code"}
    >
      {copied ? (
        <>
          <Check className={iconSize} />
          {size === "md" && (
            <span className="text-[10px] font-medium">Copied</span>
          )}
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
  const [codeText, setCodeText] = useState(rawCode || "");

  useEffect(() => {
    if (!rawCode && codeRef.current) {
      // Extract text content from the code block
      const text = codeRef.current.textContent || "";
      const rafId = window.requestAnimationFrame(() => {
        setCodeText(text);
      });
      return () => window.cancelAnimationFrame(rafId);
    }
  }, [rawCode, children]);

  const hasLanguage =
    language && language !== "text" && language !== "plaintext";

  return (
    <div
      className="group/code relative my-3 rounded-lg overflow-hidden"
      style={{
        // Derive a deeper surface from the chat background so the code
        // block always reads as an inset panel, regardless of theme.
        // (Previously this used --aurora-chat-code-block which on the
        // default dark theme was #2b2b2b — only ~7% delta from the chat
        // background, so the block almost disappeared into the page.)
        background:
          "color-mix(in srgb, var(--aurora-chat-background) 78%, #000 22%)",
        border:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 80%, transparent)",
      }}
    >
      {/* Header bar with language and copy button — slightly lighter than
          the code surface to read as a chrome strip on top of the panel. */}
      <div
        className="flex items-center justify-between px-3 py-1.5 border-b"
        style={{
          background:
            "color-mix(in srgb, var(--aurora-chat-background) 92%, #fff 4%)",
          borderColor:
            "color-mix(in srgb, var(--aurora-common-border) 70%, transparent)",
        }}
      >
        <div className="flex items-center gap-1.5">
          {hasLanguage && (
            <>
              <span
                style={{ color: "var(--aurora-common-primary)", opacity: 0.8 }}
              >
                {getLanguageIcon(language)}
              </span>
              <span
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{
                  color: "var(--aurora-editor-foreground)",
                  opacity: 0.6,
                }}
              >
                {getLanguageDisplayName(language)}
              </span>
            </>
          )}
        </div>
        <CopyButton text={codeText || rawCode || ""} size="sm" />
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
    let language = "";
    let rawCode = "";

    React.Children.forEach(children, (child) => {
      if (React.isValidElement(child) && child.props?.className) {
        const match = child.props.className.match(/language-(\w+)/);
        if (match) language = match[1];
        // Try to get raw code from children
        if (typeof child.props.children === "string") {
          rawCode = child.props.children;
        }
      }
    });

    return (
      <CodeBlockWrapper language={language} rawCode={rawCode}>
        <pre
          className="p-3 text-[12px] leading-relaxed m-0"
          style={{
            background: "transparent",
            fontFamily:
              "'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'SF Mono', Monaco, monospace",
          }}
          {...props}
        >
          {children}
        </pre>
      </CodeBlockWrapper>
    );
  },

  // Code blocks - inline and block
  code: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLElement>) => {
    const isCodeBlock = className?.includes("language-");

    if (isCodeBlock) {
      return (
        <code
          className={className}
          style={{
            fontFamily:
              "'Fira Code', 'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: "12px",
            lineHeight: "1.6",
            color: "var(--aurora-editor-foreground)",
          }}
          {...props}
        >
          {children}
        </code>
      );
    }

    // Inline code - VS Code / GitHub style: same text color as body, subtle
    // background tint, hairline border. Using common-primary as the text
    // color was unprofessional (whole sentences with inline `code` lit up
    // in accent orange/amber). Body text reads naturally now; the subtle
    // background tint is the only visual differentiator.
    return (
      <code
        className="px-1.5 py-0.5 rounded font-mono text-[12px] mx-[1px]"
        style={{
          background:
            "color-mix(in srgb, var(--aurora-editor-foreground) 7%, transparent)",
          color: "var(--aurora-common-text-primary)",
          border:
            "1px solid color-mix(in srgb, var(--aurora-common-border) 55%, transparent)",
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
      className="my-2 text-[14px] leading-[1.65] tracking-[0.01em]"
      style={{ color: "var(--aurora-common-text-primary)" }}
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
        color: "var(--aurora-common-text-primary)",
        borderColor: "var(--aurora-common-border)",
      }}
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2
      className="text-base font-bold mt-4 mb-2"
      style={{ color: "var(--aurora-common-text-primary)" }}
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h3
      className="text-sm font-semibold mt-3 mb-1.5"
      style={{ color: "var(--aurora-common-text-primary)" }}
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h4
      className="mt-2 mb-1 text-[14px] font-semibold"
      style={{ color: "var(--aurora-common-text-primary)" }}
      {...props}
    >
      {children}
    </h4>
  ),

  // Lists with better styling
  ul: ({
    children,
    style,
    className,
    ...props
  }: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      className={["my-2 space-y-1 text-[14px]", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
      style={{
        ...(style || {}),
        color: "var(--aurora-common-text-primary)",
        listStyleType: "disc",
        paddingLeft: "1.25rem",
        listStylePosition: "outside",
      }}
    >
      {children}
    </ul>
  ),
  ol: ({
    children,
    style,
    className,
    ...props
  }: React.HTMLAttributes<HTMLOListElement>) => (
    <ol
      className={["my-2 space-y-1 text-[14px]", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
      style={{
        ...(style || {}),
        color: "var(--aurora-common-text-primary)",
        listStyleType: "decimal",
        paddingLeft: "1.25rem",
        listStylePosition: "outside",
      }}
    >
      {children}
    </ol>
  ),
  li: ({
    children,
    style,
    className,
    ...props
  }: React.HTMLAttributes<HTMLLIElement>) => (
    <li
      className={["text-[14px] leading-[1.65]", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
      style={{
        ...(style || {}),
        color: "var(--aurora-common-text-primary)",
      }}
    >
      {children}
    </li>
  ),

  // Links
  a: ({
    href,
    children,
    ...props
  }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="hover:underline transition-colors"
      style={{ color: "var(--aurora-common-primary)" }}
      {...props}
    >
      {children}
    </a>
  ),

  // Blockquotes with accent border
  blockquote: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      className="border-l-3 pl-4 my-3 py-1 rounded-r"
      style={{
        borderLeftWidth: "3px",
        borderColor: "var(--aurora-common-primary)",
        background:
          "color-mix(in srgb, var(--aurora-common-primary) 8%, transparent)",
      }}
      {...props}
    >
      <div
        style={{ color: "var(--aurora-common-text-primary)", opacity: 0.85 }}
      >
        {children}
      </div>
    </blockquote>
  ),

  // Horizontal rule
  hr: (props: React.HTMLAttributes<HTMLHRElement>) => (
    <hr
      className="my-4 border-0 h-px"
      style={{ background: "var(--aurora-common-border)" }}
      {...props}
    />
  ),

  // Strong/Bold
  strong: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <strong
      className="font-semibold"
      style={{ color: "var(--aurora-common-text-primary)" }}
      {...props}
    >
      {children}
    </strong>
  ),

  // Emphasis/Italic
  em: ({ children, ...props }: React.HTMLAttributes<HTMLElement>) => (
    <em
      className="italic"
      style={{ color: "var(--aurora-common-text-primary)" }}
      {...props}
    >
      {children}
    </em>
  ),

  // Tables — professionally styled with a deeper-than-chat surface so the
  // grid actually reads as a contained panel (previously the table fill
  // was --aurora-sidebar-background which on the default dark theme is
  // identical to --aurora-chat-background, making the table effectively
  // invisible against the message stream). Every layer is derived from
  // chat-background via color-mix so it adapts to any theme.
  table: ({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) => (
    <div
      className="my-4 overflow-x-auto scrollbar-thin rounded-lg"
      style={{
        background:
          "color-mix(in srgb, var(--aurora-chat-background) 78%, #000 22%)",
        border:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 80%, transparent)",
      }}
    >
      <table
        className="min-w-full text-[12px] border-collapse"
        style={{ background: "transparent" }}
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <thead
      style={{
        // Header strip reads as chrome on top of the deeper table fill —
        // intentionally lighter than the body surface for visual hierarchy.
        background:
          "color-mix(in srgb, var(--aurora-chat-background) 92%, #fff 4%)",
        borderBottom:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 80%, transparent)",
      }}
      {...props}
    >
      {children}
    </thead>
  ),
  tbody: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLTableSectionElement>) => (
    <tbody {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }: React.HTMLAttributes<HTMLTableRowElement>) => (
    <tr
      className="transition-colors"
      style={{
        // Subtle zebra striping using a derived tint instead of input/30
        // (which on identical-bg themes was invisible).
        // The :nth-child rule lives in index.css via .markdown-content tr.
      }}
      {...props}
    >
      {children}
    </tr>
  ),
  th: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <th
      className="px-4 py-2.5 text-left font-semibold text-[11px] uppercase tracking-[0.06em]"
      style={{
        color:
          "color-mix(in srgb, var(--aurora-common-text-primary) 75%, transparent)",
      }}
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.HTMLAttributes<HTMLTableCellElement>) => (
    <td
      className="px-4 py-2.5 align-top"
      style={{
        color: "var(--aurora-common-text-primary)",
        borderTop:
          "1px solid color-mix(in srgb, var(--aurora-common-border) 50%, transparent)",
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
      style={{ color: "var(--aurora-common-text-primary)", opacity: 0.5 }}
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
      style={{ border: "1px solid var(--aurora-common-border)" }}
      {...props}
    />
  ),
};

// Streaming cursor component - compact animated dot matrix
const StreamingCursor: React.FC = () => (
  <span
    className="inline-flex items-center ml-1 align-baseline"
    style={{ transform: "translateY(1px)" }}
    aria-hidden="true"
  >
    <StreamingDotMatrix size={8} />
  </span>
);

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = memo(
  ({ content, isStreaming = false }) => {
    const activeThemeType = useThemeStore(
      (state) =>
        state.themes.find((theme) => theme.id === state.activeThemeId)?.type ??
        "dark",
    );
    const shikiTheme:
      | ["github-light", "github-light"]
      | ["github-dark", "github-dark"] =
      activeThemeType === "light"
        ? ["github-light", "github-light"]
        : ["github-dark", "github-dark"];

    if (!content) return null;

    return (
      <div className="markdown-content overflow-hidden">
        <Streamdown
          isAnimating={isStreaming}
          components={components}
          shikiTheme={shikiTheme}
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
  },
);

MarkdownRenderer.displayName = "MarkdownRenderer";
