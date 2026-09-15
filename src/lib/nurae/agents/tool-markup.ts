/**
 * NURAE — universal tool-call markup parser (BR-030).
 *
 * Live traffic showed models emit tool calls as TEXT in several markup
 * dialects instead of the strict JSON envelope the agent loops ask for:
 *
 *   <tool_call>bots_list</tool_call>                                 (Qwen/OpenChat)
 *   <|tool_call_start|>[bot_create_draft(name='X')]<|tool_call_end|> (CommandR/Hermes)
 *   mcp:tool <invoke name="customers_overview"></invoke> </mcp:tool> (GLM/MCP)
 *   <dots_function_call><invoke name="fleet_status"/></dots_function_call>
 *
 * Left alone, that markup either lands in the chat bubble verbatim (worse
 * than useless) or dies as "Invalid arguments" without ever running the
 * tool. This module converts every dialect above into real registry calls
 * and strips ALL residue from the user-visible text, so a tool call is a
 * tool call no matter which syntax the model grew up with.
 */

export interface MarkupCall {
  tool: string;
  args: Record<string, unknown>;
}

const MAX_MARKUP_CALLS = 12;

// ---------------------------------------------------------------------------
// Python-literal argument parser (CommandR/Hermes style: f(name='x', n=3))
// ---------------------------------------------------------------------------

interface PyResult {
  ok: boolean;
  value?: unknown;
}

class PyParser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parseArgsList(): Record<string, unknown> | null {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.pos >= this.src.length) return out;
      // key=  (bare identifiers only)
      const keyMatch = /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*/.exec(this.src.slice(this.pos));
      if (!keyMatch) return null;
      this.pos += keyMatch[0].length;
      const value = this.value();
      if (!value.ok) return null;
      out[keyMatch[0].slice(0, keyMatch[0].indexOf('=')).trim()] = value.value;
      this.ws();
      if (this.pos >= this.src.length) return out;
      if (this.src[this.pos] === ',') {
        this.pos++;
        continue;
      }
      return null; // trailing junk (unbalanced parens etc.) → reject cleanly
    }
  }

  private ws(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private value(): PyResult {
    this.ws();
    if (this.pos >= this.src.length) return { ok: false };
    const c = this.src[this.pos];
    if (c === "'" || c === '"') return this.string(c);
    if (c === '[') return this.list();
    if (c === '{') return this.dict();
    const rest = this.src.slice(this.pos);
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (num) {
      this.pos += num[0].length;
      const n = Number(num[0]);
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false };
    }
    for (const [lit, val] of [
      ['true', true],
      ['True', true],
      ['false', false],
      ['False', false],
      ['null', null],
      ['None', null],
    ] as const) {
      if (rest.startsWith(lit)) {
        this.pos += lit.length;
        return { ok: true, value: val };
      }
    }
    return { ok: false };
  }

  private string(quote: string): PyResult {
    this.pos++; // opening quote
    let out = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\\') {
        const next = this.src[this.pos + 1];
        if (next === undefined) return { ok: false };
        const escapes: Record<string, string> = {
          n: '\n',
          t: '\t',
          r: '\r',
          "'": "'",
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
        };
        if (next === 'u' && this.pos + 5 < this.src.length) {
          const hex = this.src.slice(this.pos + 2, this.pos + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 6;
            continue;
          }
          return { ok: false };
        }
        const unescaped = escapes[next];
        if (unescaped === undefined) return { ok: false };
        out += unescaped;
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return { ok: true, value: out };
      }
      out += ch;
      this.pos++;
    }
    return { ok: false }; // unterminated string
  }

  private list(): PyResult {
    this.pos++; // [
    const out: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.pos >= this.src.length) return { ok: false };
      if (this.src[this.pos] === ']') {
        this.pos++;
        return { ok: true, value: out };
      }
      const item = this.value();
      if (!item.ok) return { ok: false };
      out.push(item.value);
      this.ws();
      if (this.src[this.pos] === ',') {
        this.pos++;
      } else if (this.src[this.pos] !== ']') {
        return { ok: false };
      }
    }
  }

  private dict(): PyResult {
    this.pos++; // {
    const out: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.pos >= this.src.length) return { ok: false };
      if (this.src[this.pos] === '}') {
        this.pos++;
        return { ok: true, value: out };
      }
      const key = this.value();
      if (!key.ok) return { ok: false };
      this.ws();
      if (this.src[this.pos] !== ':') return { ok: false };
      this.pos++;
      const val = this.value();
      if (!val.ok) return { ok: false };
      out[String(key.value)] = val.value;
      this.ws();
      if (this.src[this.pos] === ',') {
        this.pos++;
      } else if (this.src[this.pos] !== '}') {
        return { ok: false };
      }
    }
  }
}

/**
 * Parse `name='X', n=3, flags=[True, None]` style argument lists.
 * Returns undefined when the source is not a clean python literal list —
 * callers then fall back to {} (the registry reports what is missing).
 */
export function parsePythonArgs(src: string): Record<string, unknown> | undefined {
  const trimmed = src.trim();
  if (!trimmed) return {};
  const parser = new PyParser(trimmed);
  const result = parser.parseArgsList();
  return result ?? undefined;
}

/** Parse `[fn(a=1)]` / `fn(a=1)` / `fn` bodies from heredoc-style markup. */
function parseFnBody(body: string): MarkupCall | null {
  const fn = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(body);
  if (!fn) return null;
  const tool = fn[1];
  const argsSrc = fn[2];
  if (argsSrc === undefined || argsSrc.trim() === '') return { tool, args: {} };
  const args = parsePythonArgs(argsSrc);
  return { tool, args: args ?? {} };
}

/** Parse `<tool_call>` bodies: bare name, name+JSON, JSON, or fn(args). */
function parseToolCallBody(body: string): MarkupCall | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  // Whole body is a JSON object: {"name": "...", "arguments": {...}} | {"tool": ..., "args": ...}
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const name = parsed.name ?? parsed.tool;
      if (typeof name === 'string' && name.trim()) {
        const args = parsed.arguments ?? parsed.args ?? parsed.parameters ?? {};
        if (args && typeof args === 'object' && !Array.isArray(args)) {
          return { tool: name.trim(), args: args as Record<string, unknown> };
        }
        return { tool: name.trim(), args: {} };
      }
    } catch {
      /* fall through to the fn() form */
    }
    return null;
  }
  // fn(python args) — may span lines and contain nested quotes/brackets.
  const fn = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(([\s\S]*)\)\s*$/.exec(trimmed);
  if (fn) {
    const args = parsePythonArgs(fn[2]);
    return { tool: fn[1], args: args ?? {} };
  }
  // name + JSON args:  bots_list {"limit": 5}
  const withJson = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\{[\s\S]*)$/.exec(trimmed);
  if (withJson) {
    try {
      const parsed = JSON.parse(withJson[2]) as Record<string, unknown>;
      return { tool: withJson[1], args: parsed };
    } catch {
      return { tool: withJson[1], args: {} };
    }
  }
  // Bare tool name.
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return { tool: trimmed, args: {} };
  return null;
}

/** Parse `<invoke name="x">…</invoke>` children: arg_key/arg_value pairs or JSON. */
function parseInvokeBody(body: string, name: string): MarkupCall {
  const pairs = [...body.matchAll(/<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g)];
  if (pairs.length) {
    const args: Record<string, unknown> = {};
    for (const [, k, v] of pairs) {
      const key = k.trim();
      if (!key) continue;
      const raw = v.trim();
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        /* keep raw string */
      }
      args[key] = parsed;
    }
    return { tool: name, args };
  }
  const trimmed = body.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { tool: name, args: parsed };
    } catch {
      /* tolerate */
    }
  }
  return { tool: name, args: {} };
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
}

function matchAllSpans(text: string, re: RegExp): Array<{ span: Span; groups: string[] }> {
  const out: Array<{ span: Span; groups: string[] }> = [];
  for (const m of text.matchAll(re)) {
    if (m.index === undefined) continue;
    out.push({ span: { start: m.index, end: m.index + m[0].length }, groups: m.slice(1) as string[] });
  }
  return out;
}

/** Byte spans of ``` fenced regions — markup inside examples must not run. */
function fenceSpans(text: string): Span[] {
  return matchAllSpans(text, /```[\s\S]*?(?:```|$)/g).map((m) => m.span);
}

function inFences(spans: Span[], pos: number): boolean {
  return spans.some((s) => pos >= s.start && pos < s.end);
}

/**
 * Extract tool calls from every known markup dialect and return the text
 * with those spans (and stray dialect tokens) removed.
 */
export function extractMarkupCalls(text: string): { calls: MarkupCall[]; cleaned: string } {
  if (!text) return { calls: [], cleaned: text };
  const calls: MarkupCall[] = [];
  const consumed: Span[] = [];
  const fences = fenceSpans(text);

  const take = (span: Span, call: MarkupCall | null): void => {
    if (calls.length >= MAX_MARKUP_CALLS) return;
    if (call) calls.push(call);
    consumed.push(span);
  };

  // 1. <invoke name="x"> … </invoke> (self-closing tolerated) — with any
  //    wrapper (mcp:tool, dots_function_call, function_call, bare).
  for (const m of matchAllSpans(
    text,
    /<invoke\s+name\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/invoke>|<invoke\s+name\s*=\s*["']([^"']+)["']\s*\/>/g,
  )) {
    const name = (m.groups[0] ?? m.groups[2] ?? '').trim();
    if (!name || inFences(fences, m.span.start)) continue;
    take(m.span, parseInvokeBody(m.groups[1] ?? '', name));
  }

  // 2. <|tool_call_start|> … <|tool_call_end|> (Hermes/CommandR heredoc).
  for (const m of matchAllSpans(text, /<\|tool_call_start\|>([\s\S]*?)<\|tool_call_end\|>/g)) {
    if (inFences(fences, m.span.start)) continue;
    const body = (m.groups[0] ?? '').trim().replace(/^\[|\]$/g, '').trim();
    take(m.span, parseFnBody(body) ?? parseToolCallBody(body));
  }

  // 3. <tool_call> … </tool_call> (Qwen/OpenChat).
  for (const m of matchAllSpans(text, /<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    if (inFences(fences, m.span.start)) continue;
    take(m.span, parseToolCallBody(m.groups[0] ?? ''));
  }

  // Remove consumed spans + stray wrapper tokens, then tidy whitespace.
  let cleaned = '';
  let cursor = 0;
  for (const span of [...consumed].sort((a, b) => a.start - b.start)) {
    if (span.start < cursor) continue; // nested/overlapping match — already cut
    cleaned += text.slice(cursor, span.start);
    cursor = span.end;
  }
  cleaned += text.slice(cursor);
  cleaned = cleaned
    .replace(/<\/?mcp:tool>/g, '')
    .replace(/\bmcp:tool\b/g, '') // live traffic emits it as a bare word too
    .replace(/<\/?dots_function_call>/g, '')
    .replace(/<\/?function_call>/g, '')
    .replace(/<\|?(?:\/)?tool_call_(?:start|end)\|?>/g, '')
    .replace(/<\/?invoke\b[^>]*>/g, '')
    .replace(/<arg_key>[\s\S]*?<\/arg_key>|<arg_value>[\s\S]*?<\/arg_value>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { calls, cleaned };
}
