'use client';

/**
 * NURAE — shared markdown renderer for AI output (chats, agents, bubbles).
 * react-markdown + GFM; raw HTML in model output is never rendered.
 * Typography comes from the .md-* styles in globals.css — quiet, readable,
 * no boxes around content.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children, compact }: { children: string; compact?: boolean }) {
  return (
    <div className={compact ? 'md-body md-compact' : 'md-body'}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
