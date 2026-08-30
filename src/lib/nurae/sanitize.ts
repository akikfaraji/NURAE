/**
 * NURAE — log sanitizer.
 *
 * Central log hygiene: secrets must never reach logs. Every message that is
 * written to the Log table, console, or API responses passes through
 * sanitizeForLog(). Patterns cover Telegram bot tokens, common API key
 * formats, Bearer headers, and query-string credentials.
 */

const REDACTED = '[REDACTED]';

const PATTERNS: RegExp[] = [
  // Telegram bot tokens: <bot id 8-10 digits>:<35 chars base64url-ish>
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g,
  // OpenAI-style keys
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  // Generic high-entropy assignments: api_key=..., token=..., key=...
  /\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // URL query credentials: ?key=... &token=...
  /\b([?&])(key|token|secret|access_token|apikey|api_key)=[^&\s]+/gi,
];

/** Remove every credential-looking substring from a log message. */
export function sanitizeForLog(input: string): string {
  let out = String(input ?? '');
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Preserve URL structure for query params: "?key=[REDACTED]"
      if (match.startsWith('?') || match.startsWith('&')) {
        return match.slice(0, match.indexOf('=') + 1) + REDACTED;
      }
      return REDACTED;
    });
  }
  // Control characters can forge log lines — strip them.
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return out;
}

/** Truncate long log messages so a runaway AI response cannot flood storage. */
export function truncateForLog(input: string, max = 2000): string {
  const s = sanitizeForLog(input);
  return s.length > max ? s.slice(0, max) + `…[truncated ${s.length - max} chars]` : s;
}
