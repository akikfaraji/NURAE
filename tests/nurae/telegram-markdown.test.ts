/**
 * NURAE — Telegram markdown conversion tests (Task 15).
 *
 * Covers:
 *  - telegramHtmlFromMarkdown: headings, bold/italic/strike, code spans and
 *    fences, links, bare URLs, lists, blockquotes, tables, HTML escaping,
 *    snake_case protection, unpaired-marker pass-through.
 *  - chunkTelegramMessage: limit guarantee + no data loss.
 *  - Pipeline integration: AI replies are delivered with parse_mode HTML,
 *    and a Telegram 400 rejection degrades to a plain-text retry (the user
 *    ALWAYS gets the answer).
 */

import { describe, expect, it } from 'vitest';
import {
  chunkTelegramMessage,
  telegramHtmlFromMarkdown,
} from '../../src/lib/nurae/telegram/markdown';
import { handleBotMessage, type InboundMessage } from '../../src/lib/nurae/runtime/pipeline';
import type { RuntimeBotRecord, RuntimeStore } from '../../src/lib/nurae/runtime/store';
import { TelegramApiError } from '../../src/lib/nurae/telegram/adapter';
import type { selectProvider } from '../../src/lib/nurae/ai/registry';

describe('telegramHtmlFromMarkdown', () => {
  it('converts headings to bold lines without the # marker', () => {
    expect(telegramHtmlFromMarkdown('# Hello')).toBe('<b>Hello</b>');
    expect(telegramHtmlFromMarkdown('### Deep title')).toBe('<b>Deep title</b>');
  });

  it('converts **bold**, *italic* and ~~strike~~', () => {
    expect(telegramHtmlFromMarkdown('**bold** text')).toBe('<b>bold</b> text');
    expect(telegramHtmlFromMarkdown('this is *italic* ok')).toBe('this is <i>italic</i> ok');
    expect(telegramHtmlFromMarkdown('~~gone~~')).toBe('<s>gone</s>');
  });

  it('leaves snake_case and 12_000 style underscores untouched', () => {
    expect(telegramHtmlFromMarkdown('my_var_name stays')).toBe('my_var_name stays');
    expect(telegramHtmlFromMarkdown('price 12_000 USD')).toBe('price 12_000 USD');
  });

  it('wraps code spans and does not format markdown inside them', () => {
    expect(telegramHtmlFromMarkdown('run `npm install` now')).toBe('run <code>npm install</code> now');
    expect(telegramHtmlFromMarkdown('`*not italic*`')).toBe('<code>*not italic*</code>');
  });

  it('converts fenced code blocks into <pre> and escapes their content', () => {
    const out = telegramHtmlFromMarkdown('```\nconst a = 1 < 2 && 3 > 2;\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('1 &lt; 2 &amp;&amp; 3 &gt; 2');
    expect(out).not.toContain('< 2');
  });

  it('keeps the language class of fenced code blocks', () => {
    const out = telegramHtmlFromMarkdown('```python\nprint("hi")\n```');
    expect(out).toContain('<pre><code class="language-python">');
  });

  it('converts markdown links and bare URLs to <a>', () => {
    expect(telegramHtmlFromMarkdown('[NURAE](https://t.me/nurae_bot)')).toBe(
      '<a href="https://t.me/nurae_bot">NURAE</a>',
    );
    expect(telegramHtmlFromMarkdown('see https://example.com/x for more')).toBe(
      'see <a href="https://example.com/x">https://example.com/x</a> for more',
    );
  });

  it('does NOT linkify unsafe schemes in markdown links', () => {
    const out = telegramHtmlFromMarkdown('[click](javascript:alert(1))');
    expect(out).not.toContain('<a href="javascript');
    expect(out).toContain('javascript');
  });

  it('escapes HTML injection attempts', () => {
    const out = telegramHtmlFromMarkdown('<script>alert(1)</script> & <b>fake</b>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
    // The literal "<b>fake</b>" text must not become a real tag.
    expect(out).not.toContain('<b>fake</b>');
  });

  it('converts bullets, ordered lists and horizontal rules', () => {
    const out = telegramHtmlFromMarkdown('- first\n- second\n\n1. one\n2) two\n\n---');
    expect(out).toContain('• first');
    expect(out).toContain('• second');
    expect(out).toContain('1. one');
    expect(out).toContain('2. two');
    expect(out).toContain('─');
  });

  it('groups consecutive blockquote lines into one <blockquote>', () => {
    const out = telegramHtmlFromMarkdown('> line one\n> line two');
    expect(out).toBe('<blockquote>line one\nline two</blockquote>');
  });

  it('drops the table alignment separator and keeps rows readable', () => {
    const out = telegramHtmlFromMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(out).not.toContain('---');
    expect(out).toContain('a | b');
    expect(out).toContain('1 | 2');
  });

  it('passes unpaired markers through as literal text', () => {
    expect(telegramHtmlFromMarkdown('50% * discount')).toBe('50% * discount');
    expect(telegramHtmlFromMarkdown('a ** b')).toBe('a ** b');
  });

  it('renders a full AI-style answer without leftover markdown noise', () => {
    const md = [
      '# Setup Guide',
      '',
      'Follow these **steps**:',
      '',
      '- Install the `app`',
      '- Open https://example.com/start',
      '',
      '```bash',
      'npm run start',
      '```',
    ].join('\n');
    const out = telegramHtmlFromMarkdown(md);
    expect(out).not.toContain('#');
    expect(out).toContain('<b>Setup Guide</b>');
    expect(out).toContain('<b>steps</b>');
    expect(out).toContain('<code>app</code>');
    expect(out).toContain('<a href="https://example.com/start">');
    expect(out).toContain('<pre><code class="language-bash">npm run start</code></pre>');
  });
});

describe('chunkTelegramMessage', () => {
  it('returns a single chunk for short messages', () => {
    expect(chunkTelegramMessage('hello world')).toEqual(['hello world']);
  });

  it('splits long text at paragraph boundaries within the limit', () => {
    const para = 'Lorem ipsum dolor sit amet.\n\n'.repeat(400); // ~11k chars
    const chunks = chunkTelegramMessage(para);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
    // No data lost (paragraph text preserved).
    const rejoined = chunks.join('\n\n');
    for (const piece of para.split('\n\n').filter(Boolean)) {
      expect(rejoined).toContain(piece);
    }
  });

  it('hard-slices a single line longer than the limit', () => {
    const line = 'x'.repeat(9500);
    const chunks = chunkTelegramMessage(line);
    expect(chunks.length).toBe(3);
    expect(chunks.join('')).toBe(line);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
  });
});

describe('pipeline AI reply delivery', () => {
  const bot = {
    id: 'bot-1',
    name: 'NURAE CS Bot',
    systemPrompt: 'You are helpful.',
    provider: 'openrouter',
    model: 'openrouter/free',
    temperature: 0.7,
    maxTokens: 1024,
    memorySize: 10,
    enabled: true,
    status: 'stopped',
    telegramToken: 'token',
    apiKey: 'key',
    baseUrl: null,
  } as unknown as RuntimeBotRecord;

  const msg: InboundMessage = { chatId: '42', text: 'hi', fromBot: false };

  function fakeStore(): RuntimeStore {
    return {
      async appendUserMessage() {},
      async getRecentMessages() {
        return [];
      },
      async appendAssistantMessage() {},
      async trimConversation() {},
      async createLog() {},
    } as unknown as RuntimeStore;
  }

  const fakeSelector = (() => ({
    info: { id: 'openrouter', requiresKey: true },
    apiKey: 'key',
    baseUrl: null,
    provider: {
      async generate() {
        return '# Reply\n\n**bold** answer';
      },
    },
  })) as unknown as typeof selectProvider;

  it('sends AI replies with parse_mode HTML and converted markdown', async () => {
    const sends: Array<{ chatId: string; text: string; parseMode?: string }> = [];
    const sender = {
      async sendMessage(_chatId: string, text: string, opts?: { parseMode?: 'HTML' }) {
        sends.push({ chatId: _chatId, text, parseMode: opts?.parseMode });
      },
    };
    await handleBotMessage(bot, sender, msg, { store: fakeStore(), providerSelector: fakeSelector });
    expect(sends).toHaveLength(1);
    expect(sends[0].parseMode).toBe('HTML');
    expect(sends[0].text).toBe('<b>Reply</b>\n\n<b>bold</b> answer');
  });

  it('falls back to plain text when Telegram rejects the HTML (400)', async () => {
    const sends: Array<{ text: string; parseMode?: string }> = [];
    const sender = {
      async sendMessage(_chatId: string, text: string, opts?: { parseMode?: 'HTML' }) {
        if (opts?.parseMode === 'HTML') {
          throw new TelegramApiError('api_error', "Bad Request: can't parse entities", { status: 400 });
        }
        sends.push({ text, parseMode: opts?.parseMode });
      },
    };
    await handleBotMessage(bot, sender, msg, { store: fakeStore(), providerSelector: fakeSelector });
    expect(sends).toHaveLength(1);
    expect(sends[0].parseMode).toBeUndefined();
    // Raw markdown, not the converted HTML.
    expect(sends[0].text).toBe('# Reply\n\n**bold** answer');
  });

  it('sends system texts (e.g. /start) without parse_mode', async () => {
    const sends: Array<{ text: string; parseMode?: string }> = [];
    const sender = {
      async sendMessage(_chatId: string, text: string, opts?: { parseMode?: 'HTML' }) {
        sends.push({ text, parseMode: opts?.parseMode });
      },
    };
    await handleBotMessage(bot, sender, { ...msg, text: '/start' }, { store: fakeStore() });
    expect(sends).toHaveLength(1);
    expect(sends[0].parseMode).toBeUndefined();
    expect(sends[0].text).toContain('NURAE CS Bot is online');
  });
});
