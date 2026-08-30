import { BotRuntime } from '../src/lib/nurae/runtime/bot-runtime';
import type { RuntimeBotRecord, RuntimeStore } from '../src/lib/nurae/runtime/store';
import { TelegramApiError } from '../src/lib/nurae/telegram/adapter';

const updates = [
  {
    update_id: 1,
    message: {
      message_id: 1,
      from: { id: 1, is_bot: false, first_name: 'T' },
      chat: { id: 777, type: 'private' },
      date: 1,
      text: '/start',
    },
  },
];

const store: RuntimeStore = {
  async getBot(id) {
    return {
      id,
      projectId: 'p',
      name: 'TestBot',
      systemPrompt: 'sys',
      provider: 'zai',
      model: 'm',
      temperature: 0.7,
      maxTokens: 100,
      memorySize: 4,
      enabled: true,
      status: 'stopped',
      telegramToken: 'tok',
      apiKey: null,
      baseUrl: null,
    } as RuntimeBotRecord;
  },
  async updateBotRuntimeState() {},
  async getRecentMessages() {
    return [];
  },
  async appendUserMessage(botId, chatId, content) {
    console.log('appendUser', botId, chatId, content);
  },
  async appendAssistantMessage(botId, chatId, content) {
    console.log('appendAssistant', botId, chatId, content);
  },
  async trimConversation() {},
  async createLog(_botId, level, message) {
    console.log('LOG', level, message);
  },
};

const adapter = {
  async getMe() {
    return { id: 1, username: 'fake_bot' };
  },
  async deleteWebhook() {},
  async getUpdates(_offset: number, o?: { signal?: AbortSignal }) {
    if (updates.length) return updates.splice(0);
    return new Promise<never[]>((resolve) => {
      o?.signal?.addEventListener('abort', () => resolve([]), { once: true });
    });
  },
  async sendMessage(chatId: number, text: string) {
    console.log('SEND', chatId, JSON.stringify(text.slice(0, 40)));
  },
};

const selector = () => ({
  provider: {
    id: 'fake',
    generate: async (messages: Array<{ role: string; content: string }>) => {
      console.log('GEN called with', messages.length, 'messages');
      return 'echo: ' + (messages[messages.length - 1]?.content ?? '');
    },
    validateCredentials: async () => ({ valid: true }),
  },
  info: { requiresKey: false, id: 'fake', label: 'Fake' },
  apiKey: null,
  baseUrl: null,
});

const rt = new BotRuntime(await store.getBot('bot-1') as RuntimeBotRecord, {
  store,
  adapterFactory: () => adapter as never,
  providerSelector: selector as never,
});
await rt.start();
console.log('started, status =', rt.status);
await new Promise((r) => setTimeout(r, 300));
await rt.stop();
console.log('stopped');
