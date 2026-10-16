/**
 * NURAE — Qwen/OpenChat tool_call dialect regression (live-verified bug).
 *
 * The parser's dialect-3 regex lost its opening tag to a tooling pass that
 * strips the plain literal from source files; every real <tool_call> block
 * was then matched from the START of the message, failed to parse, and was
 * silently dropped — the bot builder agent announced a tool call and never
 * executed it. The tag below is assembled from pieces for the same reason.
 */

import './helpers';
import { describe, expect, test } from 'vitest';

import { extractMarkupCalls } from '../../src/lib/nurae/agents/tool-markup';

const OPEN = '<' + 'tool_call>';
const CLOSE = '</' + 'tool_call>';

describe('tool_call dialect (regression: dropped opening tag)', () => {
  test('a call preceded by assistant text is extracted and the text kept', () => {
    const text =
      "I'll create SliceBot now.\n" +
      OPEN +
      '{"name": "bot_create_draft", "arguments": {"name": "SliceBot", "system_prompt": "You are helpful."}}' +
      CLOSE;
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('bot_create_draft');
    expect(calls[0].args).toMatchObject({ name: 'SliceBot' });
    expect(cleaned).toContain("I'll create SliceBot now.");
    expect(cleaned).not.toContain('bot_create_draft');
  });

  test('python-style args in the heredoc form parse too', () => {
    const text = OPEN + "[bot_create_draft(name='Pizza Bot', description='d')]" + CLOSE;
    const { calls } = extractMarkupCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('bot_create_draft');
    expect(calls[0].args).toMatchObject({ name: 'Pizza Bot' });
  });

  test('multiple calls in one message all survive', () => {
    const text =
      OPEN + '{"name": "bots_list", "arguments": {}}' + CLOSE +
      ' then ' +
      OPEN + '{"name": "bot_get", "arguments": {"bot_id": "b1"}}' + CLOSE;
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls.map((c) => c.tool)).toEqual(['bots_list', 'bot_get']);
    expect(cleaned).toContain('then');
  });

  test('an example inside a fenced block is documentation, not a call', () => {
    const text = 'Example:\n```\n' + OPEN + '{"name": "bots_list", "arguments": {}}' + CLOSE + '\n```';
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toHaveLength(0);
    expect(cleaned).toContain('bots_list');
  });

  test('a truncated (unmatched) opening tag leaves no residue in chat text', () => {
    const text = 'Working on it… ' + OPEN + '{"name": "bots_list"';
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toHaveLength(0);
    expect(cleaned).not.toContain(OPEN);
  });
});
