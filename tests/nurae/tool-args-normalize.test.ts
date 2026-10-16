/**
 * NURAE — agent tool argument normalization (snake_case repair).
 *
 * Free models on OpenRouter routinely emit `system_prompt`/`bot_id` despite
 * camelCase tool schemas; every such call used to die on .strict() and burn
 * a full agent round. The normalizer must map known shapes and keep unknown
 * keys honest.
 */

import './helpers';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';

const { normalizeToolArgs, getTool } = await import('../../src/lib/nurae/agents/tools');

const SampleSchema = z
  .object({
    botId: z.string(),
    systemPrompt: z.string().optional(),
    maxTokens: z.number().int().optional(),
  })
  .strict();

describe('normalizeToolArgs (snake_case → camelCase repair)', () => {
  test('maps snake_case keys onto the schema shape', () => {
    const out = normalizeToolArgs(SampleSchema, { bot_id: 'b1', system_prompt: 'hi', max_tokens: 5 });
    expect(out).toEqual({ botId: 'b1', systemPrompt: 'hi', maxTokens: 5 });
    expect(() => SampleSchema.parse(out)).not.toThrow();
  });

  test('explicit camelCase keys pass through untouched', () => {
    const out = normalizeToolArgs(SampleSchema, { botId: 'b1', systemPrompt: 'hi' });
    expect(out).toEqual({ botId: 'b1', systemPrompt: 'hi' });
  });

  test('camelCase wins when the model sends both spellings', () => {
    const out = normalizeToolArgs(SampleSchema, { bot_id: 'snake', botId: 'camel' });
    expect(out).toEqual({ botId: 'camel' });
  });

  test('genuinely unknown keys are kept so .strict() rejects them honestly', () => {
    const out = normalizeToolArgs(SampleSchema, { botId: 'b1', nonsense_key: 'x' });
    expect(out).toEqual({ botId: 'b1', nonsense_key: 'x' });
    expect(() => SampleSchema.parse(out)).toThrow(/Unrecognized/);
  });

  test('non-object and array args pass through unchanged', () => {
    expect(normalizeToolArgs(SampleSchema, null)).toBeNull();
    expect(normalizeToolArgs(SampleSchema, [1, 2])).toEqual([1, 2]);
    expect(normalizeToolArgs(SampleSchema, 'str')).toBe('str');
  });

  test('schemas without a shape (non-object) pass through', () => {
    expect(normalizeToolArgs(z.string(), { a: 1 })).toEqual({ a: 1 });
  });

  test('the real bot_create_draft schema accepts a snake_case draft call', () => {
    const tool = getTool('bot_create_draft') as { schema: z.ZodTypeAny } | undefined;
    expect(tool).toBeTruthy();
    const repaired = normalizeToolArgs(tool!.schema, {
      name: 'Test Bot',
      description: 'd',
      system_prompt: 'You are helpful.',
    });
    expect(() => tool!.schema.parse(repaired)).not.toThrow();
  });
});

describe('normalizeToolArgs synonyms (live-verified model inventions)', () => {
  test('synonym does NOT apply when the schema lacks the target key (kept → strict rejects)', () => {
    // SampleSchema has no `description` key — the synonym must not invent one;
    // the unknown key is kept so .strict() reports it honestly.
    const out = normalizeToolArgs(SampleSchema, { botId: 'b1', short_description: 'hi' });
    expect(out).toEqual({ botId: 'b1', short_description: 'hi' });
    expect(() => SampleSchema.parse(out)).toThrow(/Unrecognized/);
  });

  test('synonym applies only when the schema owns the target key (bot_create_draft)', () => {
    const tool = getTool('bot_create_draft') as { schema: z.ZodTypeAny };
    const repaired = normalizeToolArgs(tool.schema, {
      name: 'FitCoach',
      short_description: 'A gym bot',
      system_prompt: 'Coach users.',
    });
    expect(() => tool.schema.parse(repaired)).not.toThrow();
  });
});
