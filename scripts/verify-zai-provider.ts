/**
 * NURAE — verification: built-in GLM provider generates a real AI reply.
 * Mirrors the exact pipeline used by BotRuntime.
 */
import { selectProvider } from '../src/lib/nurae/ai/registry';

async function main() {
  const selection = selectProvider('zai', {});
  console.log('provider:', selection.info.label, '| key needed:', selection.info.requiresKey);
  const reply = await selection.provider.generate(
    [
      { role: 'system', content: 'You are a helpful customer-support assistant. Answer clearly and concisely.' },
      { role: 'user', content: 'In one short sentence: what is NURAE?' },
    ],
    { model: 'glm-4.5-flash', temperature: 0.7, maxTokens: 256 },
  );
  console.log('AI REPLY:', reply.slice(0, 300));

  const check = await selection.provider.validateCredentials({});
  console.log('credentials:', check);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
