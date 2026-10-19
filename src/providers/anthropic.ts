import type {
  ModelProvider,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
  ToolCall,
  ToolSpec,
} from "./types.ts";
import { ConfigurationError, ProviderError } from "../errors.ts";

export interface AnthropicProviderOptions {
  /**
   * Anthropic API key. Defaults to process.env.ANTHROPIC_API_KEY.
   */
  apiKey?: string;
  /**
   * Model identifier. Defaults to 'claude-3-5-sonnet-20241022'.
   */
  model?: string;
  /**
   * Base URL for the Anthropic API. Defaults to 'https://api.anthropic.com/v1'.
   */
  baseURL?: string;
  /**
   * Anthropic API version header. Defaults to '2023-06-01'.
   */
  anthropicVersion?: string;
  /**
   * Custom fetch implementation for testing or proxies.
   */
  fetch?: typeof fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private apiKey?: string;
  private baseURL: string;
  private anthropicVersion: string;
  private fetchFn: typeof fetch;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.ANTHROPIC_API_KEY : undefined);
    this.model = options.model ?? "claude-3-5-sonnet-20241022";
    this.name = `anthropic:${this.model}`;
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com/v1").replace(/\/$/, "");
    this.anthropicVersion = options.anthropicVersion ?? "2023-06-01";
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private ensureApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new ConfigurationError(
        "Anthropic API key is missing. Set ANTHROPIC_API_KEY environment variable or pass { apiKey } in options."
      );
    }
    return this.apiKey;
  }

  private translateTools(toolSpecs?: ToolSpec[]): Array<Record<string, unknown>> | undefined {
    if (!toolSpecs || toolSpecs.length === 0) return undefined;
    return toolSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      input_schema: spec.parameters,
    }));
  }

  private translateMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
    const anthropicMessages: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        // System messages are handled at top-level request in Anthropic
        continue;
      }

      if (msg.role === "user") {
        anthropicMessages.push({
          role: "user",
          content: msg.content,
        });
      } else if (msg.role === "assistant") {
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (msg.content) {
          contentBlocks.push({ type: "text", text: msg.content });
        }
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          for (const tc of msg.toolCalls) {
            let parsedArgs = tc.arguments;
            if (typeof parsedArgs === "string") {
              try {
                parsedArgs = JSON.parse(parsedArgs);
              } catch {
                parsedArgs = {};
              }
            }
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: tc.name,
              input: parsedArgs,
            });
          }
        }
        anthropicMessages.push({
          role: "assistant",
          content: contentBlocks.length > 0 ? contentBlocks : msg.content || "",
        });
      } else if (msg.role === "tool" && msg.toolResult) {
        const rawRes = msg.toolResult.result;
        const resultString = typeof rawRes === "string" ? rawRes : JSON.stringify(rawRes);
        anthropicMessages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.toolResult.toolCallId,
              content: resultString,
              is_error: Boolean(msg.toolResult.isError),
            },
          ],
        });
      }
    }

    return anthropicMessages;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = this.ensureApiKey();

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens ?? 2048,
      messages: this.translateMessages(request.messages),
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }

    const tools = this.translateTools(request.tools);
    if (tools) {
      body.tools = tools;
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseURL}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": this.anthropicVersion,
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      });
    } catch (networkErr: any) {
      throw new ProviderError(`Anthropic network request failed: ${networkErr.message}`, {
        provider: this.name,
        isTransient: true,
      });
    }

    if (!response.ok) {
      let errBody: any;
      try {
        errBody = await response.json();
      } catch {
        errBody = await response.text();
      }
      const message = errBody?.error?.message ?? JSON.stringify(errBody);
      throw new ProviderError(`Anthropic API error (${response.status}): ${message}`, {
        provider: this.name,
        statusCode: response.status,
        details: typeof errBody === "object" ? errBody : { raw: errBody },
      });
    }

    const data = (await response.json()) as any;
    let content = "";
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input ?? {},
          });
        }
      }
    }

    let stopReason = data.stop_reason ?? "end_turn";
    if (data.stop_reason === "tool_use") {
      stopReason = "tool_use";
    }

    const usage = data.usage
      ? {
          promptTokens: data.usage.input_tokens ?? 0,
          completionTokens: data.usage.output_tokens ?? 0,
          totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
        }
      : undefined;

    return {
      content: content || undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason,
      usage,
    };
  }

  async *stream(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamChunk, ProviderResponse, unknown> {
    const res = await this.generate(request);
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
}

/**
 * Convenience factory to create an AnthropicProvider.
 */
export function anthropic(options?: AnthropicProviderOptions): AnthropicProvider {
  return new AnthropicProvider(options);
}
