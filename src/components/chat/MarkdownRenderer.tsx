import React, { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

interface MarkdownRendererProps {
  content: string;
}

// Custom components for markdown rendering
const components: Components = {
  // Code blocks
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || '');
    const isInline = !match && !className;
    
    if (isInline) {
      return (
        <code 
          className="px-1 py-0.5 rounded bg-input text-primary font-mono text-[11px]"
          {...props}
        >
          {children}
        </code>
      );
    }
    
    return (
      <div className="my-2 rounded-lg overflow-hidden border border-border">
        {match && (
          <div className="px-3 py-1 bg-titlebar text-[10px] text-text-secondary font-mono border-b border-border">
            {match[1]}
          </div>
        )}
        <pre className="p-3 bg-editor overflow-x-auto scrollbar-thin">
          <code className="text-[11px] font-mono text-text-primary leading-relaxed" {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  },
  
  // Paragraphs
  p({ children }) {
    return (
      <p className="text-[13px] leading-relaxed text-text-primary my-1.5">
        {children}
      </p>
    );
  },
  
  // Headers
  h1({ children }) {
    return <h1 className="text-lg font-bold text-text-primary mt-3 mb-2">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-bold text-text-primary mt-3 mb-1.5">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold text-text-primary mt-2 mb-1">{children}</h3>;
  },
  h4({ children }) {
    return <h4 className="text-[13px] font-semibold text-text-primary mt-2 mb-1">{children}</h4>;
  },
  
  // Lists
  ul({ children }) {
    return <ul className="list-disc list-inside my-1.5 space-y-0.5 text-[13px] text-text-primary">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal list-inside my-1.5 space-y-0.5 text-[13px] text-text-primary">{children}</ol>;
  },
  li({ children }) {
    return <li className="text-[13px] text-text-primary leading-relaxed">{children}</li>;
  },
  
  // Links
  a({ href, children }) {
    return (
      <a 
        href={href} 
        target="_blank" 
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        {children}
      </a>
    );
  },
  
  // Blockquotes
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-primary/50 pl-3 my-2 text-text-secondary italic">
        {children}
      </blockquote>
    );
  },
  
  // Horizontal rule
  hr() {
    return <hr className="my-3 border-border" />;
  },
  
  // Strong/Bold
  strong({ children }) {
    return <strong className="font-semibold text-text-primary">{children}</strong>;
  },
  
  // Emphasis/Italic
  em({ children }) {
    return <em className="italic text-text-primary">{children}</em>;
  },
  
  // Tables
  table({ children }) {
    return (
      <div className="my-2 overflow-x-auto scrollbar-thin">
        <table className="min-w-full text-[12px] border border-border rounded">
          {children}
        </table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-titlebar">{children}</thead>;
  },
  tbody({ children }) {
    return <tbody className="divide-y divide-border">{children}</tbody>;
  },
  tr({ children }) {
    return <tr className="hover:bg-input/30">{children}</tr>;
  },
  th({ children }) {
    return <th className="px-2 py-1.5 text-left font-semibold text-text-primary border-b border-border">{children}</th>;
  },
  td({ children }) {
    return <td className="px-2 py-1.5 text-text-secondary">{children}</td>;
  },
  
  // Delete/Strikethrough
  del({ children }) {
    return <del className="line-through text-text-disabled">{children}</del>;
  },
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = memo(({ content }) => {
  if (!content) return null;
  
  return (
    <div className="markdown-content overflow-hidden">
      <ReactMarkdown 
        remarkPlugins={[remarkGfm]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});

MarkdownRenderer.displayName = 'MarkdownRenderer';

