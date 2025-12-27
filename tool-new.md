```tsx
import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, Check, X, Loader2, FileCode, Terminal } from 'lucide-react';
import clsx from 'clsx';
import type { ToolCall } from '../../types';

interface CodeViewProps {
  data?: any;
  error?: string;
}

const CodeView: React.FC<CodeViewProps> = ({ data, error }) => {
  if (error) {
    return (
      <div className="font-mono text-[10px] text-red-400 whitespace-pre-wrap">
        {error}
      </div>
    );
  }

  if (!data) return null;

  const highlight = (json: string) =>
    json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'text-amber-400';
        if (/^"/.test(match)) {
          cls = /:$/.test(match) ? 'text-sky-300' : 'text-emerald-300';
        } else if (/true|false/.test(match)) {
          cls = 'text-purple-400';
        } else if (/null/.test(match)) {
          cls = 'text-zinc-500';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );

  const isJson = typeof data !== 'string';
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div className="relative group/code">
      <div className="absolute right-2 top-2 opacity-0 group-hover/code:opacity-100 transition-opacity">
        <div className="text-[9px] text-zinc-500 uppercase tracking-wider font-semibold">
          {isJson ? 'JSON' : 'TEXT'}
        </div>
      </div>
      <pre className="font-mono text-[11px] leading-relaxed overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-700 pb-2">
        {isJson ? (
          <code dangerouslySetInnerHTML={{ __html: highlight(content) }} />
        ) : (
          <code className="text-zinc-300">{content}</code>
        )}
      </pre>
    </div>
  );
};

interface GlassPillProps {
  tool: ToolCall;
}

const GlassPill: React.FC<GlassPillProps> = ({ tool }) => {
  const [isOpen, setIsOpen] = useState(false);
  const isRunning = tool.status === 'executing' || tool.status === 'pending';
  const isError = tool.status === 'failed' || tool.status === 'rejected';

  useEffect(() => {
    if (isRunning) setIsOpen(true);
  }, [isRunning]);

  const displayData = useMemo(() => {
    if (tool.name.includes('file') && tool.args?.content) {
      return tool.args.content;
    }
    if (tool.result) {
      try {
        return JSON.parse(tool.result);
      } catch {
        return tool.result;
      }
    }
    return null;
  }, [tool]);

  return (
    <div className="group relative pl-6 pb-2">
      <div className="absolute left-[9px] top-6 h-full w-px bg-white/5 group-last:hidden" />

      <div
        className={clsx(
          'absolute left-0 top-2 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 shadow-[0_0_10px_rgba(0,0,0,0.2)] backdrop-blur-md transition-all z-10',
          isRunning
            ? 'bg-blue-500/20 text-blue-400 animate-pulse'
            : isError
              ? 'bg-red-500/10 text-red-400'
              : 'bg-emerald-500/10 text-emerald-400'
        )}
      >
        {isRunning ? (
          <Loader2 size={10} className="animate-spin" />
        ) : isError ? (
          <X size={10} />
        ) : (
          <Check size={10} />
        )}
      </div>

      <div
        className={clsx(
          'overflow-hidden rounded-xl border border-white/5 bg-white/[0.02] backdrop-blur-sm transition-all duration-300',
          isOpen ? 'shadow-2xl shadow-black/40 ring-1 ring-white/10' : 'hover:bg-white/[0.04]'
        )}
      >
        <button
          onClick={() => setIsOpen((prev) => !prev)}
          className="flex w-full items-center gap-3 px-3 py-2.5 text-left"
        >
          <span className="font-mono text-xs font-medium text-zinc-300 tracking-tight">{tool.name}</span>
          {tool.name.includes('file') && <FileCode size={12} className="text-zinc-600" />}

          <div className="ml-auto flex items-center gap-3">
            <span
              className={clsx(
                'text-[9px] uppercase tracking-wider font-semibold',
                isRunning ? 'text-blue-400' : isError ? 'text-red-400' : 'text-emerald-500/50'
              )}
            >
              {tool.status}
            </span>
            <ChevronRight
              size={14}
              className={clsx('text-zinc-600 transition-transform duration-300', isOpen && 'rotate-90')}
            />
          </div>
        </button>

        <div className={clsx('grid transition-all duration-300 ease-in-out', isOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="overflow-hidden">
            <div className="border-t border-white/5 bg-black/20 px-3 py-3">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {Object.entries(tool.args || {})
                  .filter(([key]) => key !== 'content')
                  .map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center gap-1.5 rounded bg-white/5 px-2 py-1 text-[10px] border border-white/5"
                    >
                      <span className="text-zinc-500">{key}</span>
                      <span className="text-zinc-300 font-mono">
                        {String(value).length > 30 ? `${String(value).slice(0, 30)}…` : String(value)}
                      </span>
                    </div>
                  ))}
              </div>

              {(displayData || tool.error) && (
                <div className="rounded-lg border border-white/5 bg-[#080808] p-3 shadow-inner">
                  <CodeView data={displayData} error={tool.error} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface ToolTimelineProps {
  tools: ToolCall[];
}

export const ToolTimeline: React.FC<ToolTimelineProps> = ({ tools }) => {
  if (!tools || tools.length === 0) return null;

  return (
    <div className="space-y-1 p-2">
      {tools.map((tool) => (
        <GlassPill key={tool.id} tool={tool} />
      ))}
    </div>
  );
};
```
