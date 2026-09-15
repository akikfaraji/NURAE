import './helpers';
/**
 * NURAE — BR-030 regression tests: universal tool-call markup parsing.
 *
 * Every dialect string below is copied verbatim from live screenshots
 * (Sep 13–15) where the model emitted tool calls as text and the chat
 * showed the raw markup (or died with "Invalid arguments"). These tests
 * pin the contract: markup becomes real registry calls, and the
 * user-visible text never contains dialect residue.
 */

import { describe, expect, test } from 'vitest';

const { extractMarkupCalls, parsePythonArgs } = await import('../../src/lib/nurae/agents/tool-markup');
const { parseAgentReply } = await import('../../src/lib/nurae/agents/bot-builder');

describe('parsePythonArgs', () => {
  test('parses python-literal lists with nested structures', () => {
    const args = parsePythonArgs(
      `name='RestaurantBot', description='A restaurant bot that helps customers', n=3, ok=True`,
    );
    expect(args).toEqual({
      name: 'RestaurantBot',
      description: 'A restaurant bot that helps customers',
      n: 3,
      ok: true,
    });
  });

  test('parses nested lists/dicts (the live bot_create_draft shape)', () => {
    const args = parsePythonArgs(
      `name='RestaurantBot', behaviors=[{'id': 'welcome', 'when': {'type': 'start'}, ` +
        `'steps': [{'type': 'message', 'text': 'Welcome!', 'buttons': [{'label': 'Menu', ` +
        `'action': {'kind': 'flow', 'behaviorId': 'menu'}}]}]}]`,
    );
    expect(args).toBeDefined();
    expect(args!['name']).toBe('RestaurantBot');
    const behaviors = args!['behaviors'] as Array<Record<string, unknown>>;
    expect(behaviors[0]['id']).toBe('welcome');
    const steps = behaviors[0]['steps'] as Array<Record<string, unknown>>;
    expect(steps[0]['text']).toBe('Welcome!');
    const buttons = steps[0]['buttons'] as Array<Record<string, unknown>>;
    expect((buttons[0]['action'] as Record<string, unknown>)['behaviorId']).toBe('menu');
  });

  test('handles escaped quotes inside single-quoted strings', () => {
    const args = parsePythonArgs(`name='O\\'Brien Bot', note="double \\"quoted\\""`);
    expect(args!['name']).toBe("O'Brien Bot");
    expect(args!['note']).toBe('double "quoted"');
  });

  test('None/null/False map to null/false; empty source to {}', () => {
    expect(parsePythonArgs(`x=None, y=False`)).toEqual({ x: null, y: false });
    expect(parsePythonArgs('')).toEqual({});
    expect(parsePythonArgs('not a call')).toBeUndefined();
  });
});

describe('extractMarkupCalls — live dialects', () => {
  test('Qwen style: bare tool name (live: bots_list never executed)', () => {
    const { calls, cleaned } = extractMarkupCalls('<tool_call>bots_list\n</tool_call>');
    expect(calls).toEqual([{ tool: 'bots_list', args: {} }]);
    expect(cleaned).toBe('');
  });

  test('GLM/MCP style: mcp:tool + invoke wrapper (live operator leak)', () => {
    const text = `I'll pull up the latest customer data for you.\n\nmcp:tool <invoke name="customers_overview">\n</invoke> </mcp:tool>`;
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toEqual([{ tool: 'customers_overview', args: {} }]);
    expect(cleaned).toContain('latest customer data');
    expect(cleaned).not.toContain('mcp:tool');
    expect(cleaned).not.toContain('invoke');
  });

  test('dots_function_call wrapper with doubled opener (live fleet_status leak)', () => {
    const text = `<dots_function_call><dots_function_call>\n<invoke name="fleet_status"> </invoke>\n</dots_function_call>`;
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toEqual([{ tool: 'fleet_status', args: {} }]);
    expect(cleaned).not.toContain('dots');
  });

  test('Hermes heredoc with python args (live: Invalid arguments for bot_create_draft)', () => {
    const text =
      `<|tool_call_start|>[bot_create_draft(name='RestaurantBot', description='A restaurant bot', ` +
      `behaviors=[{'id': 'welcome', 'when': {'type': 'start'}, 'steps': [{'type': 'message', ` +
      `'text': 'Welcome! How can I help you today?'}]}])]<|tool_call_end|>`;
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('bot_create_draft');
    expect(calls[0].args['name']).toBe('RestaurantBot');
    expect(Array.isArray(calls[0].args['behaviors'])).toBe(true);
    expect(cleaned).toBe('');
  });

  test('tool_call body as JSON envelope variant', () => {
    const { calls } = extractMarkupCalls(
      `<tool_call>{"name": "platform_logs", "arguments": {"level": "info|warn|error"}}</tool_call>`,
    );
    expect(calls).toEqual([{ tool: 'platform_logs', args: { level: 'info|warn|error' } }]);
  });

  test('invoke with arg_key/arg_value pairs', () => {
    const text =
      `mcp:tool <invoke name="platform_logs">` +
      `<arg_key>level</arg_key><arg_value>info|warn|error</arg_value>` +
      `<arg_key>event</arg_key><arg_value></arg_value></invoke> </mcp:tool>`;
    const { calls } = extractMarkupCalls(text);
    expect(calls).toEqual([
      { tool: 'platform_logs', args: { level: 'info|warn|error', event: '' } },
    ]);
  });

  test('name + JSON args inside tool_call', () => {
    const { calls } = extractMarkupCalls('<tool_call>bots_list {"limit": 5}\n</tool_call>');
    expect(calls).toEqual([{ tool: 'bots_list', args: { limit: 5 } }]);
  });

  test('markup inside code fences is documentation, never executed', () => {
    const text = 'Example:\n```\n<tool_call>bots_list</tool_call>\n```\nDone.';
    const { calls, cleaned } = extractMarkupCalls(text);
    expect(calls).toEqual([]);
    expect(cleaned).toContain('Example:');
  });
});

describe('parseAgentReply integration', () => {
  test('markup-only turn: prose kept, action extracted, loop stays alive', () => {
    const text = `Let me get a fresh snapshot of the platform.\n\nmcp:tool <invoke name="platform_overview">\n</invoke> </mcp:tool>`;
    const parsed = parseAgentReply(text);
    expect(parsed.message).toBe('Let me get a fresh snapshot of the platform.');
    expect(parsed.actions).toEqual([{ tool: 'platform_overview', args: {} }]);
    expect(parsed.done).toBe(false);
    expect(parsed.jsonOk).toBe(false);
  });

  test('envelope + markup merge into one action list', () => {
    const text =
      `<tool_call>bots_list</tool_call>` +
      `{"message": "Checking the fleet.", "actions": [{"tool": "bot_analytics", "args": {}}], "done": true}`;
    const parsed = parseAgentReply(text);
    expect(parsed.jsonOk).toBe(true);
    expect(parsed.actions.map((a) => a.tool)).toEqual(['bot_analytics', 'bots_list']);
    expect(parsed.done).toBe(true);
  });

  test('heredoc python call now yields executable args (Invalid-arguments fix)', () => {
    const text =
      `<|tool_call_start|>[bot_create_draft(name='MyShop', description='sells stuff', ` +
      `systemPrompt='You are a shop assistant.')]<|tool_call_end|>`;
    const parsed = parseAgentReply(text);
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions[0].tool).toBe('bot_create_draft');
    expect(parsed.actions[0].args['name']).toBe('MyShop');
  });

  test('plain prose without any markup is untouched', () => {
    const parsed = parseAgentReply('Sure thing! One moment while I check.');
    expect(parsed.message).toBe('Sure thing! One moment while I check.');
    expect(parsed.actions).toEqual([]);
    expect(parsed.done).toBe(true);
  });

  test('JSON envelope without markup behaves exactly as before', () => {
    const parsed = parseAgentReply('{"message": "Hi", "actions": [], "done": true}');
    expect(parsed.message).toBe('Hi');
    expect(parsed.done).toBe(true);
    expect(parsed.jsonOk).toBe(true);
  });
});
