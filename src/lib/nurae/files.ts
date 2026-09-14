/**
 * NURAE — user files: upload, storage, text extraction, retrieval.
 *
 * Design notes:
 *  - No third-party parser dependencies. PDF text is extracted with a
 *    conservative built-in parser (zlib-inflate every stream, then read the
 *    text-showing operators). DOCX is a ZIP: inflate `word/document.xml` and
 *    read the <w:t> runs. Plain text/markdown/CSV pass straight through.
 *    Extraction that fails yields status "binary" — the file is still stored
 *    and referenced, but agents are told no text could be read. No lying.
 *  - Small text files stay inline in the DB (`content`); binaries go to
 *    `db/uploads/<id>.<ext>`. Extracted text ALWAYS lives in the DB so
 *    retrieval works even where the filesystem is ephemeral (Vercel).
 *  - Retrieval (`pickFileContext`) caps how much text enters a model context:
 *    files are summarized by head+tail slices, never dumped whole.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { inflateSync, inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { appRoot } from '@/lib/paths';
import { db } from '@/lib/db';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_TEXT_BYTES = 1024 * 1024; // inline text cap (1 MB)
export const MAX_EXTRACT_CHARS = 200_000; // extraction cap

export type FileKind = 'text' | 'pdf' | 'docx' | 'csv' | 'image' | 'other';
export type FileStatus = 'ready' | 'binary' | 'failed';

export interface StoredFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: FileKind;
  status: FileStatus;
  hasText: boolean;
}

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
]);

const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/x-markdown',
  'application/json',
  'application/xml',
]);

export function classifyFile(name: string, mime: string): FileKind {
  const ext = path.extname(name).toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'pdf';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return 'docx';
  }
  if (IMAGE_MIMES.has(mime) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
    return 'image';
  }
  if (ext === '.csv' || mime === 'text/csv') return 'csv';
  if (TEXT_MIMES.has(mime) || ['.txt', '.md', '.markdown', '.json', '.log'].includes(ext)) {
    return 'text';
  }
  return 'other';
}

// ---------------------------------------------------------------------------
// PDF — minimal, dependency-free text extraction
// ---------------------------------------------------------------------------

/** Decode PDF string escapes (\n \r \t \( \) \\ and octal). */
function decodePdfString(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      // Up to three octal digits.
      let oct = '';
      let j = i + 1;
      while (j < raw.length && oct.length < 3 && raw[j] >= '0' && raw[j] <= '7') {
        oct += raw[j];
        j++;
      }
      out += String.fromCharCode(parseInt(oct, 8));
      i = j - 1;
      continue;
    }
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    out += map[next] ?? next;
    i += 1;
  }
  return out;
}

/** Pull text-showing operators out of one decoded content stream. */
function textFromContentStream(content: string): string {
  let out = '';
  // (string) Tj   and   [(s1) num (s2)] TJ   within the whole stream.
  const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|'|")|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) {
      out += decodePdfString(m[1]);
      out += '\n';
    } else if (m[2] !== undefined) {
      const inner = /\(((?:\\.|[^\\()])*)\)/g;
      let s: RegExpExecArray | null;
      while ((s = inner.exec(m[2])) !== null) out += decodePdfString(s[1]);
      out += '\n';
    }
  }
  return out;
}

/**
 * Extract text from a PDF buffer. Conservative: tries zlib on every
 * `stream…endstream` chunk and also reads uncompressed content. Text beyond
 * plain Latin/CJK byte strings (custom encodings) may come out imperfect —
 * extraction failure is reported honestly (status "binary").
 */
export function extractPdfText(buf: Buffer): string {
  const latin = buf.toString('latin1');
  const pieces: string[] = [];

  // 1. Compressed streams.
  const re = /stream\r?\n?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    const chunk = buf.subarray(start, end);
    for (const attempt of [inflateSync, inflateRawSync]) {
      try {
        const inflated = attempt(chunk);
        const text = textFromContentStream(inflated.toString('latin1'));
        if (text.trim()) pieces.push(text);
        break;
      } catch {
        /* not zlib — try the next mode */
      }
    }
    re.lastIndex = end;
  }

  // 2. Uncompressed top-level content (rare but cheap to try).
  const bt: string[] = [];
  const btRe = /BT([\s\S]*?)ET/g;
  let b: RegExpExecArray | null;
  while ((b = btRe.exec(latin)) !== null) {
    const text = textFromContentStream(b[1]);
    if (text.trim()) bt.push(text);
  }
  if (bt.length) pieces.push(...bt);

  const joined = pieces.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return joined.slice(0, MAX_EXTRACT_CHARS);
}

// ---------------------------------------------------------------------------
// DOCX — ZIP container: inflate word/document.xml, read <w:t> runs
// ---------------------------------------------------------------------------

/** Minimal ZIP reader: returns the decompressed bytes of one stored file. */
function zipEntry(buf: Buffer, wantedName: string): Buffer | null {
  // Walk local file headers from the start (files are small; this is fine).
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break; // local header signature
    const method = buf.readUInt16LE(off + 8);
    let compressedSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;
    // Streaming entries may carry zero sizes in the local header — fall back
    // to the central directory when the size looks wrong.
    if (compressedSize === 0 || dataStart + compressedSize > buf.length) {
      compressedSize = centralDirectorySize(buf, name);
      if (compressedSize === 0 || dataStart + compressedSize > buf.length) {
        off = dataStart;
        continue;
      }
    }
    if (name === wantedName) {
      const data = buf.subarray(dataStart, dataStart + compressedSize);
      try {
        return method === 0 ? Buffer.from(data) : inflateRawSync(data);
      } catch {
        return null;
      }
    }
    off = dataStart + compressedSize;
  }
  return null;
}

function centralDirectorySize(buf: Buffer, wantedName: string): number {
  // Find the End-Of-Central-Directory record (last 64 KB is enough).
  const tailStart = Math.max(0, buf.length - 65_535);
  const tail = buf.subarray(tailStart);
  const eoCD = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eoCD === -1) return 0;
  let count = tail.readUInt16LE(eoCD + 10);
  let off = tailStart + tail.readUInt32LE(eoCD + 16);
  while (count-- > 0 && off + 46 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    if (name === wantedName) return compressedSize;
    off += 46 + nameLen + extraLen + commentLen;
  }
  return 0;
}

/** DOCX → text: one line per paragraph from <w:t> runs. */
export function extractDocxText(buf: Buffer): string {
  const xmlBuf = zipEntry(buf, 'word/document.xml');
  if (!xmlBuf) return '';
  const xml = xmlBuf.toString('utf8');
  const paragraphs = xml.split(/<\/w:p>/).map((para) => {
    const runs = para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
    return [...runs].map((r) => r[1]).join('');
  });
  const text = paragraphs
    .filter((p) => p.trim().length > 0)
    .join('\n')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)));
  return text.slice(0, MAX_EXTRACT_CHARS);
}

// ---------------------------------------------------------------------------
// Upload + retrieval
// ---------------------------------------------------------------------------

function uploadsDir(): string {
  // Project-root anchored — the standalone production server chdirs into
  // .next/standalone; a bare cwd path would fork uploads onto the build
  // output (lost on every rebuild). See src/lib/paths.ts.
  return path.join(appRoot(), 'db', 'uploads');
}

export interface SaveFileInput {
  userId: string;
  sessionId: string | null;
  name: string;
  mime: string;
  bytes: Buffer;
}

/** Store one upload: classify, extract text, persist. Never throws far. */
export async function saveUserFile(input: SaveFileInput): Promise<StoredFile> {
  const kind = classifyFile(input.name, input.mime);
  let content: string | null = null;
  let storagePath: string | null = null;
  let extractedText: string | null = null;
  let status: FileStatus = 'ready';

  if (kind === 'text' || kind === 'csv') {
    content = input.bytes.subarray(0, MAX_TEXT_BYTES).toString('utf8');
    extractedText = content.slice(0, MAX_EXTRACT_CHARS);
  } else if (kind === 'pdf') {
    const text = extractPdfText(input.bytes).trim();
    if (text) extractedText = text;
    else status = 'binary';
  } else if (kind === 'docx') {
    const text = extractDocxText(input.bytes).trim();
    if (text) extractedText = text;
    else status = 'binary';
  } else {
    status = 'binary';
  }

  // Binaries go to disk best-effort (local persistent setups benefit; the
  // extracted text is already durable in the DB).
  if (status === 'binary') {
    try {
      await mkdir(uploadsDir(), { recursive: true });
      const ext = path.extname(input.name).slice(0, 10) || '.bin';
      const file = await db.userFile.create({
        data: {
          userId: input.userId,
          sessionId: input.sessionId,
          name: input.name.slice(0, 200),
          mime: input.mime.slice(0, 100),
          size: input.bytes.length,
          kind,
          status: 'failed', // placeholder to obtain an id for the path
        },
      });
      const rel = `${file.id}${ext}`;
      await writeFile(path.join(uploadsDir(), rel), input.bytes);
      await db.userFile.update({ where: { id: file.id }, data: { storagePath: rel, status } });
      return {
        id: file.id,
        name: file.name,
        mime: file.mime,
        size: file.size,
        kind,
        status,
        hasText: false,
      };
    } catch {
      status = 'failed';
    }
  }

  const row = await db.userFile.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      name: input.name.slice(0, 200),
      mime: input.mime.slice(0, 100),
      size: input.bytes.length,
      kind,
      content,
      extractedText,
      status,
    },
  });
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    kind,
    status,
    hasText: Boolean(extractedText),
  };
}

export interface FileRef {
  fileId: string;
  name: string;
  kind: string;
  status: string;
}

/**
 * Build a compact context block for the model from referenced files.
 * Per file: head + tail slices (long files keep both ends), with the middle
 * elided. Hard cap for the whole block keeps prompts bounded.
 */
export async function pickFileContext(
  userId: string,
  refs: FileRef[],
  opts?: { perFileChars?: number; totalChars?: number },
): Promise<string> {
  const perFile = opts?.perFileChars ?? 6000;
  const total = opts?.totalChars ?? 18000;
  const parts: string[] = [];
  let used = 0;
  for (const ref of refs.slice(0, 8)) {
    // Ownership check first: a file id from history must belong to the caller.
    const row = await db.userFile.findFirst({ where: { id: ref.fileId, userId } });
    if (!row) continue;
    const text = row.extractedText ?? '';
    if (!text.trim()) {
      parts.push(`[File: ${row.name} — ${row.kind}, no extractable text]`);
      continue;
    }
    let body = text;
    if (body.length > perFile) {
      const head = body.slice(0, Math.ceil(perFile * 0.7));
      const tail = body.slice(-Math.floor(perFile * 0.3));
      body = `${head}\n[… middle omitted (${body.length} chars total) …]\n${tail}`;
    }
    const budget = total - used;
    if (budget <= 200) break;
    if (body.length > budget) body = `${body.slice(0, budget)}…`;
    used += body.length;
    parts.push(`[File: ${row.name} (${row.kind})]\n${body}`);
  }
  return parts.join('\n\n');
}
