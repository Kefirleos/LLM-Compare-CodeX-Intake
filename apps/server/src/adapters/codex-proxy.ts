import { z } from 'zod';
import { utf8Bytes, decodeNdjson, serializePrompt } from '@llm-compare/contracts';
import type { ModelDescriptor } from '@llm-compare/contracts';
import type { LlmAdapter, PreparedPrompt, StreamChunk } from './types.js';
import { AdapterError } from './error.js';

const UPSTREAM_ORIGIN = 'https://llm.codex.so';
const catalogSchema = z.object({
  default: z.string().optional(),
  models: z.array(z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(512) })).max(1000),
}).refine(({ models }) => new Set(models.map((model) => model.id)).size === models.length);
const generationSchema = z.object({ text: z.string() });
const upstreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['start', 'text-start', 'text-end', 'reasoning-start', 'reasoning-end']) }),
  z.object({ type: z.enum(['text-delta', 'reasoning-delta']), delta: z.string() }),
  z.object({ type: z.literal('finish'), finishReason: z.literal('stop').optional() }),
  z.object({ type: z.literal('error') }),
]);

const providers: Readonly<Record<string, string>> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', deepseek: 'DeepSeek',
  moonshotai: 'Moonshot AI', spacexai: 'xAI',
};
const protocolError = () => new AdapterError({
  code: 'UPSTREAM_PROTOCOL', message: 'Сервис моделей вернул ответ неожиданного формата.', retryable: true,
});

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    throw protocolError();
  }
  const advertisedLength = Number(response.headers.get('content-length'));
  if (advertisedLength > maxBytes) {
    await response.body?.cancel();
    throw protocolError();
  }
  if (!response.body) throw protocolError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw protocolError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return JSON.parse(text) as unknown;
  } catch {
    throw protocolError();
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class CodexProxyAdapter implements LlmAdapter {
  readonly mode = 'live';
  #key: string;
  #transport: typeof fetch;

  constructor(apiKey: string, transport: typeof fetch = fetch) {
    this.#key = apiKey;
    this.#transport = transport;
  }

  private async request(path: '/models' | '/generate' | '/stream', signal: AbortSignal, payload?: PreparedPrompt) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.#transport(`${UPSTREAM_ORIGIN}${path}`, {
        method: payload ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          'x-api-key': this.#key,
          accept: path === '/stream' ? 'application/x-ndjson' : 'application/json',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify({ prompt: serializePrompt(payload.prompt, payload.history ?? []), model: payload.modelId }) } : {}),
        signal,
      });
    } catch {
      signal.throwIfAborted();
      throw new AdapterError({ code: 'UPSTREAM_UNAVAILABLE', message: 'Сервис моделей недоступен. Повторите запрос позже.', retryable: true });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) throw new AdapterError({
        code: 'UPSTREAM_AUTH', message: 'Сервис моделей отклонил доступ. Проверьте серверную настройку ключа.', retryable: false,
      });
      if (response.status === 429) throw new AdapterError({
        code: 'UPSTREAM_RATE_LIMIT', message: 'Достигнут лимит сервиса моделей. Повторите запрос позже.', retryable: true,
      });
      if (response.status >= 500) throw new AdapterError({
        code: 'UPSTREAM_UNAVAILABLE', message: 'Сервис моделей временно недоступен.', retryable: true,
      });
      throw protocolError();
    }
    return response;
  }

  async listModels(signal: AbortSignal): Promise<ModelDescriptor[]> {
    const parsed = catalogSchema.safeParse(await readBoundedJson(await this.request('/models', signal), 1024 * 1024));
    if (!parsed.success) throw protocolError();
    return parsed.data.models.map(({ id, name }) => ({
      id, displayName: name, provider: providers[id.split('/')[0] ?? ''] ?? 'Провайдер не указан',
      capabilities: { streaming: 'unknown', reasoning: 'unknown' },
      pricing: null, metadataSource: 'upstream',
    }));
  }

  async generate(input: PreparedPrompt, signal: AbortSignal) {
    const parsed = generationSchema.safeParse(await readBoundedJson(await this.request('/generate', signal, input), 4 * 1024 * 1024));
    if (!parsed.success) throw protocolError();
    if (utf8Bytes(parsed.data.text) > 512 * 1024) throw new AdapterError({
      code: 'OUTPUT_LIMIT', message: 'Ответ модели превышает допустимый размер.', retryable: false,
    });
    return { text: parsed.data.text };
  }

  async *stream(input: PreparedPrompt, signal: AbortSignal, onActivity?: () => void): AsyncGenerator<StreamChunk> {
    const response = await this.request('/stream', signal, input);
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-ndjson' || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw protocolError();
    }
    let finished = false;
    try {
      for await (const raw of decodeNdjson(response.body, signal)) {
        const parsed = upstreamEventSchema.safeParse(raw);
        if (!parsed.success) throw protocolError();
        const event = parsed.data;
        if (event.type === 'error') throw new AdapterError({ code: 'GENERATION_FAILED', message: 'Сервис моделей прервал ответ.', retryable: true });
        if ((event.type === 'text-delta' || event.type === 'reasoning-delta') && event.delta.length > 0) onActivity?.();
        if (event.type === 'text-delta') yield event.delta;
        if (event.type === 'reasoning-start') yield { type: 'reasoning_started' };
        if (event.type === 'reasoning-delta') yield { type: 'reasoning_delta', text: event.delta };
        if (event.type === 'reasoning-end') yield { type: 'reasoning_ended' };
        if (event.type === 'finish') { finished = true; break; }
      }
      if (!finished) throw protocolError();
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof AdapterError) throw error;
      throw protocolError();
    }
  }
}
