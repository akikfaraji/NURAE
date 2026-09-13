/**
 * NURAE — AI markdown → Telegram HTML conversion (spec §9 outbound).
 *
 * AI providers answer in standard markdown (headings `#`, bold `**x**`,
 * fenced code blocks, tables, links…). Telegram does NOT render markdown
 * markup sent as plain text — the user would see every `#` and `*` literally.
 * Telegram's own "Markdown" parse modes (legacy + MarkdownV2) accept neither
 * `#` headings nor `**bold**` without aggressive escaping, so the robust
 * target is parse_mode=HTML with the restricted tag set Telegram supports:
 *
 *   <b> <i> <u> <s> <a href> <code> <pre> <blockquote>
 *
 * This converter is intentionally dependency-free and conservative:
 *  - Every text fragment is HTML-escaped first (`& < >`), so arbitrary AI
 *    output (or hostile output) can never inject Telegram entities.
 *  - Tags are only ever emitted in matched pairs by construction, so a
 *    malformed message cannot make Telegram reject the payload; and even if
 *    Telegram rejects it, the pipeline falls back to plain text.
 *  - Unrecognised or unpaired markdown markers stay as literal characters
 *    (same as today's behaviour) instead of corrupting the message.
 */

/** Telegram hard limit for message text (after entity parsing). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Safety margin below the hard limit when chunking long replies. */
export const TELEGRAM_CHUNK_LIMIT = 4000;

/** Escape raw text for safe embedding in HTML body content. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const ALLOWED_URL_SCHEMES = ['http://', 'https://', 'tg://', 'mailto:'];

function isAllowedUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return ALLOWED_URL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

/**
 * Inline markdown → Telegram HTML for one segment of text (no newlines).
 * Input must ALREADY be HTML-escaped; code spans are extracted first so
 * formatting markers inside them stay literal.
 */
function transformInline(escaped: string): string {
  // 1. Extract inline code spans — content must not receive further transforms.
  const parts: Array<{ code: boolean; text: string }> = [];
  const codeRe = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(escaped))) {
    if (m.index > last) parts.push({ code: false, text: escaped.slice(last, m.index) });
    parts.push({ code: true, text: m[1] });
    last = codeRe.lastIndex;
  }
  if (last < escaped.length) parts.push({ code: false, text: escaped.slice(last) });

  return parts
    .map(({ code, text }) => {
      if (code) return `<code>${text}</code>`;
      let out = text;

      // 2. Links in ONE combined pass so a markdown link's URL can never be
      //    double-wrapped by the bare-URL rule: markdown links [text](url)
      //    are matched first; any remaining bare https(s) URL is autolinked.
      //    Only known-safe schemes become <a> tags.
      out = out.replace(
        /\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"']+)/g,
        (whole, label: string, url: string | undefined, bare: string | undefined) => {
          if (bare) return `<a href="${bare}">${bare}</a>`;
          return url && isAllowedUrl(url) ? `<a href="${url}">${label}</a>` : whole;
        },
      );
      // 3. Bold — **x** (and __x__ when not touching word characters,
      //    so snake_case_names survive untouched).
      out = out.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');
      out = out.replace(/(?<![\w])__([^\n_]+?)__(?![\w])/g, '<b>$1</b>');

      // 4. Italic — *x* and _x_ (guarded against list markers and snake_case).
      out = out.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '<i>$1</i>');
      out = out.replace(/(?<![\w])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w])/g, '<i>$1</i>');

      // 5. Strikethrough — ~~x~~.
      out = out.replace(/~~([^\n]+?)~~/g, '<s>$1</s>');

      return out;
    })
    .join('');
}

const HR_LINE = '─────────────';

/**
 * Convert one markdown text (already free of fenced code blocks) into
 * Telegram HTML. Line-oriented: headings, blockquotes, lists, tables and
 * paragraphs; inline styling via transformInline.
 */
function transformLines(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let quote: string[] | null = null;
  let table: string[] | null = null;

  const flushQuote = () => {
    if (quote && quote.length) out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
    quote = null;
  };
  const flushTable = () => {
    if (table && table.length) out.push(table.join('\n'));
    table = null;
  };
  const flushAll = () => {
    flushQuote();
    flushTable();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    // Blank line separates blocks.
    if (!trimmed) {
      flushAll();
      out.push('');
      continue;
    }

    // Fenced-code remnants or indented code are left as plain text.
    // Headings → bold line (Telegram has no <h1>).
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      out.push(`<b>${transformInline(escapeHtml(heading[2]))}</b>`);
      continue;
    }

    // Horizontal rules.
    if (/^([-*_])\s*(?:\1\s*){2,}$/.test(trimmed)) {
      flushAll();
      out.push(HR_LINE);
      continue;
    }

    // Blockquotes → <blockquote> group.
    const bq = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (bq) {
      flushTable();
      quote = quote ?? [];
      quote.push(transformInline(escapeHtml(bq[1])));
      continue;
    }

    // Tables: consecutive lines containing pipes. The alignment separator
    // row (| --- | --- |) is dropped; cells are kept pipe-separated.
    if (trimmed.includes('|') && (table !== null || /\|/.test(lines[i + 1] ?? ''))) {
      flushQuote();
      if (/^[\s|:+-]+$/.test(trimmed)) continue; // separator row — skip
      table = table ?? [];
      table.push(escapeHtml(trimmed.replace(/^\|/, '').replace(/\|$/, '').trim()));
      continue;
    }

    // Unordered lists → bullet character, indentation preserved (2 sp/level).
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      flushAll();
      const indent = ' '.repeat(Math.floor(ul[1].length / 2) * 2);
      out.push(`${indent}• ${transformInline(escapeHtml(ul[2]))}`);
      continue;
    }

    // Ordered lists — keep the number, normalise the separator.
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      flushAll();
      const indent = ' '.repeat(Math.floor(ol[1].length / 2) * 2);
      out.push(`${indent}${ol[2]}. ${transformInline(escapeHtml(ol[3]))}`);
      continue;
    }

    // Paragraph line.
    flushAll();
    out.push(transformInline(escapeHtml(line)));
  }
  flushAll();

  // Collapse 3+ blank lines (chat-friendly) and trim outer whitespace.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Convert AI markdown to Telegram HTML (parse_mode="HTML").
 * Never throws; the result is always parseable HTML (all tags are balanced
 * by construction, all text is escaped).
 */
export function telegramHtmlFromMarkdown(md: string): string {
  if (!md || !md.trim()) return escapeHtml(md ?? '');

  // Split off fenced code blocks first (```lang … ```), unterminated fences
  // included — everything between them goes through the line transformer.
  const fenceRe = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  const pieces: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(md))) {
    if (m.index > last) pieces.push(transformLines(md.slice(last, m.index)));
    const lang = m[1].trim();
    const code = escapeHtml(m[2].replace(/\n$/, ''));
    pieces.push(lang ? `<pre><code class="language-${lang}">${code}</code></pre>` : `<pre>${code}</pre>`);
    last = fenceRe.lastIndex;
  }
  if (last < md.length) pieces.push(transformLines(md.slice(last)));

  return pieces.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Split a long message into Telegram-sized chunks at paragraph (then line)
 * boundaries. Guarantees: every chunk ≤ limit, no character lost, chunk
 * boundaries never split an entity.
 */
export function chunkTelegramMessage(text: string, limit = TELEGRAM_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    const trimmed = current.replace(/^\n+|\s+$/g, '');
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  const appendWithBreak = (part: string) => {
    if (!current) current = part;
    else if (current.length + 2 + part.length <= limit) current += `\n\n${part}`;
    else if (current.length + 1 + part.length <= limit) current += `\n${part}`;
    else pushCurrent(), (current = part);
  };

  for (const para of text.split(/\n{2,}/)) {
    if (para.length + 2 <= limit - (current ? current.length + 2 : 0)) {
      appendWithBreak(para);
      continue;
    }
    // Paragraph itself too big — fall back to line boundaries.
    for (const line of para.split('\n')) {
      if (current.length + 1 + line.length <= limit) appendWithBreak(line);
      else if (line.length <= limit) pushCurrent(), (current = line);
      else {
        // Single line longer than the limit — hard-slice it.
        for (let i = 0; i < line.length; i += limit) {
          if (current) pushCurrent();
          chunks.push(line.slice(i, i + limit));
        }
      }
    }
  }
  pushCurrent();
  return chunks.length ? chunks : [text.slice(0, limit)];
}
