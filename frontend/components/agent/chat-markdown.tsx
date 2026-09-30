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
 * than pulling in a typography plugin, so an answer matches the rest of the UI:
 * body text at a comfortable reading size and line height, headings on the type
 * scale, code in overlay wells, inline identifiers as code chips.
 */
export function ChatMarkdown({ content }: { content: string }) {
  return (
    <div className="chat-markdown min-w-0 break-words text-body leading-7 text-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

const markdownComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-6 text-headline text-content first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-5 text-body font-semibold text-content first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-4 text-callout font-semibold text-content first:mt-0">{children}</h3>
  ),
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-5 marker:text-content-subtle first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-5 marker:text-content-subtle first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-content">{children}</strong>,
  em: ({ children }) => <em>{children}</em>,
  a: ({ href, children }) => (
    <a href={href} className="link underline decoration-accent/30 hover:decoration-accent">
      {children}
    </a>
  ),
  code: ({ children, className }) =>
    className?.includes('language-') ? (
      <code className="font-mono text-caption">{children}</code>
    ) : (
      <code className="code-chip break-words">{children}</code>
    ),
  // A fenced block without a language arrives as a plain `code` and would take
  // the inline chip styling; the well resets it so every block looks the same.
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-xl bg-surface-overlay px-4 py-3.5 font-mono text-caption leading-relaxed text-content first:mt-0 last:mb-0 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-content">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-surface-strong pl-4 text-content-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-surface-border" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-surface-border">
      <table className="w-full border-collapse text-callout [&_tbody_tr:last-child>td]:border-b-0">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-surface-border bg-surface-overlay/60 px-3 py-2 text-left text-meta font-medium text-content-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-surface-border/70 px-3 py-2.5 align-top">{children}</td>
  ),
};
