'use client';

/**
 * NURAE dashboard — bot configuration form (create + edit).
 * Client-side validation mirrors the server zod schemas; the server remains
 * the source of truth (frontend validation is convenience only).
 */

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BotDTO, BotInput, Catalog, nuraeApi, ProviderInfo } from '@/lib/nurae-client/api';

export interface BotFormProps {
  catalog: Catalog;
  /** When editing: current bot values. */
  bot?: BotDTO;
  submitLabel: string;
  onSubmit: (input: BotInput) => Promise<void>;
  onCancel?: () => void;
  busy?: boolean;
  serverErrors?: Record<string, string>;
}

const DEFAULT_PROMPT =
  'You are a helpful customer-support assistant.\nAnswer clearly and concisely.\nIf you do not know something, say so.';

export function BotForm({ catalog, bot, submitLabel, onSubmit, onCancel, busy, serverErrors }: BotFormProps) {
  const editing = Boolean(bot);
  const [name, setName] = useState(bot?.name ?? '');
  const [description, setDescription] = useState(bot?.description ?? '');
  const [telegramToken, setTelegramToken] = useState('');
  const [providerId, setProviderId] = useState(bot?.provider ?? 'zai');
  const [model, setModel] = useState(bot?.model ?? 'glm-4.5-flash');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(bot?.baseUrl ?? '');
  const [systemPrompt, setSystemPrompt] = useState(bot?.systemPrompt ?? DEFAULT_PROMPT);
  const [temperature, setTemperature] = useState(bot?.temperature ?? 0.7);
  const [maxTokens, setMaxTokens] = useState(bot?.maxTokens ?? 1024);
  const [memorySize, setMemorySize] = useState(bot?.memorySize ?? 10);
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const [clientError, setClientError] = useState<string | null>(null);

  const provider: ProviderInfo | undefined = useMemo(
    () => catalog.providers.find((p) => p.id === providerId),
    [catalog.providers, providerId],
  );

  // Sync model/baseUrl defaults when switching providers (create mode only).
  const handleProviderChange = (id: string) => {
    setProviderId(id);
    if (!editing) {
      const p = catalog.providers.find((x) => x.id === id);
      if (p) {
        setModel(p.defaultModel);
        setBaseUrl(p.defaultBaseUrl ?? '');
      }
    }
  };

  const errors = { ...(serverErrors ?? {}) };

  const validate = (): boolean => {
    setClientError(null);
    if (!name.trim()) {
      setClientError('Bot name is required.');
      return false;
    }
    if (!editing && !telegramToken.trim()) {
      setClientError('Telegram bot token is required.');
      return false;
    }
    if (telegramToken.trim() && !/^\d{6,12}:[A-Za-z0-9_-]{25,}$/.test(telegramToken.trim())) {
      setClientError('Telegram token format is invalid. Expected <bot_id>:<secret> from @BotFather.');
      return false;
    }
    if (!model.trim()) {
      setClientError('Model is required.');
      return false;
    }
    if (provider?.requiresKey && !apiKey.trim() && !(editing && bot?.hasApiKey)) {
      setClientError(`${provider.label} requires an API key.`);
      return false;
    }
    if (provider?.requiresBaseUrl && !baseUrl.trim()) {
      setClientError('This provider requires a base URL.');
      return false;
    }
    if (!systemPrompt.trim()) {
      setClientError('System prompt is required.');
      return false;
    }
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validate()) return;
    const input: BotInput = {
      name: name.trim(),
      description: description.trim(),
      provider: providerId,
      model: model.trim(),
      systemPrompt: systemPrompt.trim(),
      temperature,
      maxTokens,
      memorySize,
      enabled,
    };
    if (telegramToken.trim()) input.telegramToken = telegramToken.trim();
    if (apiKey.trim()) input.apiKey = apiKey.trim();
    if (baseUrl.trim()) input.baseUrl = baseUrl.trim();
    await onSubmit(input);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5" data-testid="bot-form">
      {(clientError || Object.keys(errors).length > 0) && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {clientError ?? 'Please fix the highlighted fields.'}
          {errors._form ? <div className="mt-1">{errors._form}</div> : null}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bot-name">Bot name *</Label>
          <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={catalog.limits.nameMax} placeholder="Support Assistant" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-desc">Description</Label>
          <Input id="bot-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Customer support for my shop" />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="bot-token">Telegram bot token {editing ? '(leave blank to keep current)' : '*'}</Label>
        <Input
          id="bot-token"
          type="password"
          autoComplete="off"
          value={telegramToken}
          onChange={(e) => setTelegramToken(e.target.value)}
          placeholder="1234567890:AA…  (from @BotFather)"
        />
        <p className="text-xs text-zinc-500">
          Create a bot with <span className="font-medium">@BotFather</span> on Telegram and paste the token here. It is
          stored encrypted and never shown again.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="bot-provider">AI provider *</Label>
          <Select value={providerId} onValueChange={handleProviderChange}>
            <SelectTrigger id="bot-provider">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {catalog.providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {provider && <p className="text-xs text-zinc-500">{provider.description}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-model">AI model *</Label>
          {provider && provider.models.length > 0 ? (
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="bot-model">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {provider.models.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input id="bot-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="model-name" />
          )}
        </div>
      </div>

      {provider?.requiresKey && (
        <div className="space-y-1.5">
          <Label htmlFor="bot-apikey">API key {editing && bot?.hasApiKey ? '(leave blank to keep current)' : '*'}</Label>
          <Input
            id="bot-apikey"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
          />
        </div>
      )}

      {(providerId === 'custom' || providerId === 'local') && (
        <div className="space-y-1.5">
          <Label htmlFor="bot-baseurl">Base URL {provider?.requiresBaseUrl ? '*' : '(optional)'}</Label>
          <Input id="bot-baseurl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="bot-prompt">System prompt *</Label>
        <Textarea
          id="bot-prompt"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={4}
          maxLength={catalog.limits.systemPromptMax}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="bot-temp">
            Temperature: <span className="tabular-nums">{temperature.toFixed(1)}</span>
          </Label>
          <Slider
            id="bot-temp"
            min={catalog.limits.temperatureMin}
            max={catalog.limits.temperatureMax}
            step={0.1}
            value={[temperature]}
            onValueChange={(v) => setTemperature(v[0])}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-maxtokens">Max output tokens</Label>
          <Input
            id="bot-maxtokens"
            type="number"
            min={catalog.limits.maxTokensMin}
            max={catalog.limits.maxTokensMax}
            value={maxTokens}
            onChange={(e) => setMaxTokens(Math.max(catalog.limits.maxTokensMin, Math.min(catalog.limits.maxTokensMax, Number(e.target.value) || 0)))}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bot-memory">Memory (messages)</Label>
          <Input
            id="bot-memory"
            type="number"
            min={catalog.limits.memorySizeMin}
            max={catalog.limits.memorySizeMax}
            value={memorySize}
            onChange={(e) => setMemorySize(Math.max(catalog.limits.memorySizeMin, Math.min(catalog.limits.memorySizeMax, Number(e.target.value) || 0)))}
          />
          <p className="text-xs text-zinc-500">Recent messages kept per chat.</p>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-md border border-zinc-200 p-3">
        <div>
          <Label htmlFor="bot-enabled" className="text-sm">
            Enabled
          </Label>
          <p className="text-xs text-zinc-500">Disabled bots refuse to start.</p>
        </div>
        <Switch id="bot-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={busy} className="bg-emerald-600 text-white hover:bg-emerald-700" data-testid="bot-form-submit">
          {busy ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
