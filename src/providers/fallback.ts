import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
} from "./types.ts";
import { ConfigurationError, ProviderError } from "../errors.ts";

export interface FallbackOptions {
  /**
   * Callback invoked when a provider fails and switching occurs.
   */
  onFallback?: (failedProvider: string, nextProvider: string, error: unknown) => void;
}

/**
 * A composite ModelProvider that chains multiple providers in order.
 * If the primary provider fails, it seamlessly falls back to the next provider in the chain.
 */
export class FallbackProvider implements ModelProvider {
  readonly name: string;
  readonly providers: ModelProvider[];
  private onFallback?: FallbackOptions["onFallback"];

  constructor(providers: ModelProvider[], options: FallbackOptions = {}) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new ConfigurationError("FallbackProvider requires at least one provider");
    }

    this.providers = [...providers];
    this.name = `fallback(${this.providers.map((p) => p.name).join(" -> ")})`;
    this.onFallback = options.onFallback;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const errors: Array<{ provider: string; error: unknown }> = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;

      try {
        return await provider.generate(request);
      } catch (err: unknown) {
        errors.push({ provider: provider.name, error: err });

        const nextProvider = this.providers[i + 1];
        if (nextProvider) {
          if (this.onFallback) {
            this.onFallback(provider.name, nextProvider.name, err);
          }
          // Continue to next provider in fallback chain
          continue;
        }

        // All providers in chain exhausted
        const errorMessages = errors
          .map((e) => `[${e.provider}]: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
          .join("; ");

        throw new ProviderError(
          `All fallback providers exhausted (${this.providers.length} attempted). Errors: ${errorMessages}`,
          {
            provider: this.name,
            details: { errors },
          }
        );
      }
    }

    throw new ProviderError("No providers were executed in fallback chain", {
      provider: this.name,
    });
  }

  async *stream(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamChunk, ProviderResponse, unknown> {
    const errors: Array<{ provider: string; error: unknown }> = [];

    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;

      try {
        if (typeof provider.stream === "function") {
          const gen = provider.stream(request);

          while (true) {
            const next = await gen.next();
            if (next.done) {
              return next.value as ProviderResponse;
            }
            yield next.value;
          }
        } else {
          // If stream not implemented on provider, generate and yield text
          const res = await provider.generate(request);
          if (res.content) {
            yield { type: "text_delta", text: res.content };
          }
          if (res.toolCalls) {
            for (const tc of res.toolCalls) {
              yield { type: "tool_call_delta", toolCall: tc };
            }
          }
          return res;
        }
      } catch (err: unknown) {
        errors.push({ provider: provider.name, error: err });

        const nextProvider = this.providers[i + 1];
        if (nextProvider) {
          if (this.onFallback) {
            this.onFallback(provider.name, nextProvider.name, err);
          }
          continue;
        }

        const errorMessages = errors
          .map((e) => `[${e.provider}]: ${e.error instanceof Error ? e.error.message : String(e.error)}`)
          .join("; ");

        throw new ProviderError(
          `All streaming fallback providers exhausted (${this.providers.length} attempted). Errors: ${errorMessages}`,
          {
            provider: this.name,
            details: { errors },
          }
        );
      }
    }

    throw new ProviderError("No streaming providers were executed in fallback chain", {
      provider: this.name,
    });
  }
}

/**
 * Convenience helper to create a FallbackProvider.
 */
export function fallbackProvider(
  primary: ModelProvider,
  ...fallbacks: ModelProvider[]
): FallbackProvider {
  return new FallbackProvider([primary, ...fallbacks]);
}

/**
 * Alias for fallbackProvider.
 */
export const fallback = fallbackProvider;
