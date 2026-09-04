'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

/**
 * Markdown rendered for a chat answer (ADR-029).
 *
 * The model answers in Markdown, so a chat answer is rendered rather than shown
 * as literal `##`, `-` and backticks. react-markdown renders to React elements
 * (never dangerouslySetInnerHTML), so repository content that reaches an answer
 * cannot inject HTML — the AI data boundary and this renderer are independent
 * layers, and this one renders text only.
 *
 * Component overrides restyle each element into the portal's own tokens rather
 * than pulling in a typography plugin, so an answer matches the rest of the UI.
 */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-markdown text-sm leading-relaxed text-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold text-content">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-sm font-semibold text-content">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-semibold text-content">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-content">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a href={href} className="text-accent underline decoration-accent/40 hover:decoration-accent">
      {children}
    </a>
  ),
  code: ({ children, className }) =>
    className?.includes('language-') ? (
      <code className="font-mono text-xs">{children}</code>
    ) : (
      <code className="rounded bg-surface-overlay px-1.5 py-0.5 font-mono text-xs text-content">
        {children}
      </code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-surface-overlay p-3 font-mono text-xs leading-relaxed">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-surface-border pl-3 text-content-subtle">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-surface-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-surface-border bg-surface-overlay px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-surface-border px-2 py-1 align-top">{children}</td>
  ),
};
