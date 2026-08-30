import type {
  ModelProvider,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
  ToolCall,
} from "./types.ts";
import { ProviderError } from "../errors.ts";

export type MockTurnHandler = (
  request: ProviderRequest
) => ProviderResponse | Promise<ProviderResponse>;

export type MockTurn =
  | string
  | {
      content?: string;
      toolCalls?: ToolCall[];
      stopReason?: string;
      usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    }
  | {
      error: Error | string;
      statusCode?: number;
      isTransient?: boolean;
    }
  | MockTurnHandler;

export interface MockProviderOptions {
  name?: string;
  script?: MockTurn[];
  defaultResponse?: string | MockTurnHandler;
  latencyMs?: number;
}

export class MockProvider implements ModelProvider {
  readonly name: string;
  private queue: MockTurn[] = [];
  private history: ProviderRequest[] = [];
  private defaultResponse: string | MockTurnHandler;
  private latencyMs: number;

  constructor(options: MockProviderOptions | MockTurn[] = {}) {
    if (Array.isArray(options)) {
      this.name = "mock";
      this.queue = [...options];
      this.defaultResponse = "Mock response";
      this.latencyMs = 0;
    } else {
      this.name = options.name ?? "mock";
      this.queue = options.script ? [...options.script] : [];
      this.defaultResponse = options.defaultResponse ?? "Mock response";
      this.latencyMs = options.latencyMs ?? 0;
    }
  }

  get requests(): ProviderRequest[] {
    return [...this.history];
  }

  get lastRequest(): ProviderRequest | undefined {
    return this.history[this.history.length - 1];
  }

  enqueueTurn(...turns: MockTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  setScript(turns: MockTurn[]): this {
    this.queue = [...turns];
    return this;
  }

  reset(): void {
    this.queue = [];
    this.history = [];
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.history.push(request);

    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }

    if (request.abortSignal?.aborted) {
      throw new ProviderError("Request was aborted", {
        provider: this.name,
        isTransient: false,
      });
    }

    const turn = this.queue.shift();

    if (turn === undefined) {
      if (typeof this.defaultResponse === "function") {
        return this.defaultResponse(request);
      }
      return {
        content: this.defaultResponse,
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    }

    // String turn
    if (typeof turn === "string") {
      return {
        content: turn,
        stopReason: "end_turn",
        usage: { promptTokens: 10, completionTokens: turn.split(" ").length, totalTokens: 10 + turn.split(" ").length },
      };
    }

    // Function handler turn
    if (typeof turn === "function") {
      return turn(request);
    }

    // Error simulation turn
    if ("error" in turn) {
      const err = turn.error;
      const message = typeof err === "string" ? err : err.message;
      throw new ProviderError(message, {
        provider: this.name,
        statusCode: turn.statusCode,
        isTransient: turn.isTransient,
        details: typeof err === "object" && !(err instanceof Error) ? err : undefined,
      });
    }

    // Explicit response turn
    const hasToolCalls = Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0;
    return {
      content: turn.content,
      toolCalls: turn.toolCalls,
      stopReason: turn.stopReason ?? (hasToolCalls ? "tool_use" : "end_turn"),
      usage: turn.usage ?? {
        promptTokens: 15,
        completionTokens: (turn.content?.split(" ").length ?? 0) + (hasToolCalls ? 20 : 0),
        totalTokens: 35,
      },
    };
  }

  async *stream(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamChunk, ProviderResponse, unknown> {
    const response = await this.generate(request);

    if (response.content) {
      // Chunk the content by words to simulate streaming tokens
      const words = response.content.split(" ");
      for (let i = 0; i < words.length; i++) {
        const chunkText = i === words.length - 1 ? words[i]! : words[i] + " ";
        yield {
          type: "text_delta",
          text: chunkText,
        };
      }
    }

    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        yield {
          type: "tool_call_delta",
          toolCall: tc,
        };
      }
    }

    return response;
  }
}

/**
 * Convenience helper to create a MockProvider.
 */
export function mock(options?: MockProviderOptions | MockTurn[]): MockProvider {
  return new MockProvider(options);
}
