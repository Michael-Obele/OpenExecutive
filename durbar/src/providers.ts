/**
 * Model access — one OpenAI-compatible client, parameterized per vendor.
 *
 * Every provider this project targets (DeepSeek, OpenRouter, and any
 * self-hosted gateway) speaks the same `/chat/completions` wire protocol, so
 * there is one implementation and no vendor branching in the calling code. A
 * provider that needs a genuinely different protocol gets its own file rather
 * than a growing `if` chain.
 *
 * Deliberately no prompt-caching headers: `cache_control` is Anthropic
 * proprietary syntax, and the reference implementation's cache architecture
 * exists solely to serve it. DeepSeek and OpenRouter cache server-side without
 * being asked, so there is nothing to configure here.
 */

import type { ProviderConfig } from './config.ts';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface ChatOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/** Injectable so tests can run the whole flow without a network call. */
export interface Provider {
  readonly name: string;
  readonly defaultModel: string;
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string>;
}

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

export function createProvider(config: ProviderConfig): Provider {
  const defaultModel = config.model;

  return {
    name: config.name,
    defaultModel,

    async chat(messages, options = {}) {
      const model = options.model ?? defaultModel;

      const body: Record<string, unknown> = { model, messages };
      if (options.temperature !== undefined) body['temperature'] = options.temperature;
      if (options.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;

      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...config.headers,
        },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });

      if (!response.ok) {
        // Read the body: providers put the actionable part (bad model, quota,
        // auth) in the payload, not the status line, and a bare "400" is
        // undiagnosable.
        const detail = await response.text().catch(() => '');
        throw new Error(
          `${config.name} ${response.status} ${response.statusText}` +
            (detail ? `: ${detail.slice(0, 500)}` : ''),
        );
      }

      const payload = (await response.json()) as CompletionResponse;
      if (payload.error?.message) {
        throw new Error(`${config.name}: ${payload.error.message}`);
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content === '') {
        throw new Error(
          `${config.name}: response contained no message content ` +
            `(model "${model}")`,
        );
      }
      return content;
    },
  };
}
