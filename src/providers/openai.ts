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

export interface OpenAIProviderOptions {
  /**
   * OpenAI API key. Defaults to process.env.OPENAI_API_KEY.
   */
  apiKey?: string;
  /**
   * Model identifier. Defaults to 'gpt-4o'.
   */
  model?: string;
  /**
   * Base URL for the OpenAI API. Defaults to 'https://api.openai.com/v1'.
   */
  baseURL?: string;
  /**
   * Optional OpenAI organization ID.
   */
  organization?: string;
  /**
   * Custom fetch implementation.
   */
  fetch?: typeof fetch;
}

export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private apiKey?: string;
  private baseURL: string;
  private organization?: string;
  private fetchFn: typeof fetch;

  constructor(options: OpenAIProviderOptions = {}) {
    this.apiKey = options.apiKey ?? (typeof process !== "undefined" ? process.env?.OPENAI_API_KEY : undefined);
    this.model = options.model ?? "gpt-4o";
    this.name = `openai:${this.model}`;
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.organization = options.organization;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private ensureApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new ConfigurationError(
        "OpenAI API key is missing. Set OPENAI_API_KEY environment variable or pass { apiKey } in options."
      );
    }
    return this.apiKey;
  }

  private translateTools(toolSpecs?: ToolSpec[]): Array<Record<string, unknown>> | undefined {
    if (!toolSpecs || toolSpecs.length === 0) return undefined;
    return toolSpecs.map((spec) => ({
      type: "function",
      function: {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      },
    }));
  }

  private translateMessages(messages: ProviderMessage[], systemPrompt?: string): Array<Record<string, unknown>> {
    const openaiMessages: Array<Record<string, unknown>> = [];

    if (systemPrompt) {
      openaiMessages.push({
        role: "system",
        content: systemPrompt,
      });
    }

    for (const msg of messages) {
      if (msg.role === "system") {
        openaiMessages.push({
          role: "system",
          content: msg.content,
        });
      } else if (msg.role === "user") {
        openaiMessages.push({
          role: "user",
          content: msg.content,
        });
      } else if (msg.role === "assistant") {
        const item: Record<string, unknown> = {
          role: "assistant",
          content: msg.content || null,
        };
        if (msg.toolCalls && msg.toolCalls.length > 0) {
          item.tool_calls = msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.name,
              arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
            },
          }));
        }
        openaiMessages.push(item);
      } else if (msg.role === "tool" && msg.toolResult) {
        const rawRes = msg.toolResult.result;
        const contentStr = typeof rawRes === "string" ? rawRes : JSON.stringify(rawRes);
        openaiMessages.push({
          role: "tool",
          tool_call_id: msg.toolResult.toolCallId,
          content: contentStr,
        });
      }
    }

    return openaiMessages;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = this.ensureApiKey();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };

    if (this.organization) {
      headers["OpenAI-Organization"] = this.organization;
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.translateMessages(request.messages, request.systemPrompt),
    };

    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      body.max_tokens = request.maxTokens;
    }

    const tools = this.translateTools(request.tools);
    if (tools) {
      body.tools = tools;
    }

    if (request.outputSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "output",
          schema: request.outputSchema,
          strict: true,
        },
      };
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: request.abortSignal,
      });
    } catch (networkErr: any) {
      throw new ProviderError(`OpenAI network request failed: ${networkErr.message}`, {
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
      throw new ProviderError(`OpenAI API error (${response.status}): ${message}`, {
        provider: this.name,
        statusCode: response.status,
        details: typeof errBody === "object" ? errBody : { raw: errBody },
      });
    }

    const data = (await response.json()) as any;
    const choice = data.choices?.[0];

    let content: string | undefined = choice?.message?.content;
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(choice?.message?.tool_calls)) {
      for (const tc of choice.message.tool_calls) {
        let parsedArgs: any = tc.function?.arguments ?? {};
        if (typeof parsedArgs === "string") {
          try {
            parsedArgs = JSON.parse(parsedArgs);
          } catch {
            // retain string if unparseable
          }
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function?.name ?? "",
          arguments: parsedArgs,
        });
      }
    }

    let stopReason = choice?.finish_reason ?? "end_turn";
    if (choice?.finish_reason === "tool_calls") {
      stopReason = "tool_use";
    } else if (choice?.finish_reason === "stop") {
      stopReason = "end_turn";
    }

    const usage = data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
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
 * Convenience factory to create an OpenAIProvider.
 */
export function openai(options?: OpenAIProviderOptions): OpenAIProvider {
  return new OpenAIProvider(options);
}
