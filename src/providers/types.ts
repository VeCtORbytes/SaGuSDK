import type { Role, ToolCall, ToolResult, TokenUsage } from "../types.ts";

export type { Role, ToolCall, ToolResult, TokenUsage };

/**
 * Message passed to or from a model provider.
 */
export interface ProviderMessage {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

/**
 * Specification of a tool supplied to the model.
 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Request payload sent to ModelProvider.generate().
 */
export interface ProviderRequest {
  messages: ProviderMessage[];
  systemPrompt?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  outputSchema?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

/**
 * Stop reasons indicating why the model finished generating.
 */
export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop" | string;

/**
 * Response payload returned from ModelProvider.generate().
 */
export interface ProviderResponse {
  content?: string;
  toolCalls?: ToolCall[];
  stopReason?: StopReason;
  usage?: TokenUsage;
}

/**
 * Streaming chunk emitted by provider stream generators.
 */
export interface ProviderStreamChunk {
  type: "text_delta" | "tool_call_delta";
  text?: string;
  toolCall?: Partial<ToolCall>;
}

/**
 * Core interface that all LLM provider adapters implement.
 */
export interface ModelProvider {
  readonly name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamChunk, ProviderResponse, unknown>;
}
