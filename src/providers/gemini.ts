import { randomUUID } from "node:crypto";
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

export interface GeminiProviderOptions {
  /**
   * Gemini / Google AI Studio API key. Defaults to process.env.GEMINI_API_KEY or process.env.GOOGLE_API_KEY.
   */
  apiKey?: string;
  /**
   * Model identifier. Defaults to 'gemini-1.5-pro'.
   */
  model?: string;
  /**
   * Base URL for the Gemini API. Defaults to 'https://generativelanguage.googleapis.com/v1beta'.
   */
  baseURL?: string;
  /**
   * Custom fetch implementation.
   */
  fetch?: typeof fetch;
}

export class GeminiProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private apiKey?: string;
  private baseURL: string;
  private fetchFn: typeof fetch;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey =
      options.apiKey ??
      (typeof process !== "undefined"
        ? process.env?.GEMINI_API_KEY ?? process.env?.GOOGLE_API_KEY
        : undefined);
    this.model = options.model ?? "gemini-1.5-pro";
    this.name = `gemini:${this.model}`;
    this.baseURL = (options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private ensureApiKey(): string {
    if (!this.apiKey || this.apiKey.trim() === "") {
      throw new ConfigurationError(
        "Gemini API key is missing. Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable or pass { apiKey } in options."
      );
    }
    return this.apiKey;
  }

  private translateTools(toolSpecs?: ToolSpec[]): Array<Record<string, unknown>> | undefined {
    if (!toolSpecs || toolSpecs.length === 0) return undefined;
    return [
      {
        functionDeclarations: toolSpecs.map((spec) => ({
          name: spec.name,
          description: spec.description,
          parameters: spec.parameters,
        })),
      },
    ];
  }

  private translateMessages(messages: ProviderMessage[]): Array<Record<string, unknown>> {
    const contents: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        continue;
      }

      if (msg.role === "user") {
        contents.push({
          role: "user",
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (msg.content) {
          parts.push({ text: msg.content });
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
            parts.push({
              functionCall: {
                name: tc.name,
                args: parsedArgs,
              },
            });
          }
        }
        contents.push({
          role: "model",
          parts: parts.length > 0 ? parts : [{ text: "" }],
        });
      } else if (msg.role === "tool" && msg.toolResult) {
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: msg.toolResult.name,
                response: {
                  result: msg.toolResult.result,
                },
              },
            },
          ],
        });
      }
    }

    return contents;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const apiKey = this.ensureApiKey();

    const body: Record<string, unknown> = {
      contents: this.translateMessages(request.messages),
    };

    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature;
    }
    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens;
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const tools = this.translateTools(request.tools);
    if (tools) {
      body.tools = tools;
    }

    const url = `${this.baseURL}/models/${this.model}:generateContent?key=${apiKey}`;

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.abortSignal,
      });
    } catch (networkErr: any) {
      throw new ProviderError(`Gemini network request failed: ${networkErr.message}`, {
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
      throw new ProviderError(`Gemini API error (${response.status}): ${message}`, {
        provider: this.name,
        statusCode: response.status,
        details: typeof errBody === "object" ? errBody : { raw: errBody },
      });
    }

    const data = (await response.json()) as any;
    const candidate = data.candidates?.[0];

    let content = "";
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(candidate?.content?.parts)) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content += part.text;
        }
        if (part.functionCall) {
          toolCalls.push({
            id: randomUUID(),
            name: part.functionCall.name,
            arguments: part.functionCall.args ?? {},
          });
        }
      }
    }

    let stopReason = "end_turn";
    if (toolCalls.length > 0) {
      stopReason = "tool_use";
    }

    const usage = data.usageMetadata
      ? {
          promptTokens: data.usageMetadata.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
          totalTokens: data.usageMetadata.totalTokenCount ?? 0,
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
 * Convenience factory to create a GeminiProvider.
 */
export function gemini(options?: GeminiProviderOptions): GeminiProvider {
  return new GeminiProvider(options);
}
