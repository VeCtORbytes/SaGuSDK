import type { z } from "zod";
import type { SaguError } from "./errors.ts";

/**
 * Message roles supported in the Sagu SDK.
 */
export type Role = "system" | "user" | "assistant" | "tool";

/**
 * Represents a tool call requested by a model.
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

/**
 * Represents the result of an executed tool call.
 */
export interface ToolResult {
  toolCallId: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

/**
 * Unified message representation for Sagu agents.
 */
export interface Message {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
  metadata?: Record<string, unknown>;
}

/**
 * Token usage accounting.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * Context provided to tools during execution.
 */
export interface ToolContext {
  agentName?: string;
  runId?: string;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Standard Tool definition.
 */
export interface Tool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context?: ToolContext) => Promise<TOutput> | TOutput;
  requiresApproval?: boolean;
  timeoutMs?: number;
  toJSONSchema?: () => Record<string, unknown>;
}

/**
 * Guardrail result shape.
 */
export interface GuardrailResult<T = string> {
  pass: boolean;
  reason?: string;
  modified?: T;
}

export interface GuardrailContext {
  agentName?: string;
  runId?: string;
  [key: string]: unknown;
}

export type InputGuardrail = (
  input: string,
  context?: GuardrailContext
) => Promise<GuardrailResult<string>> | GuardrailResult<string>;

export type OutputGuardrail = (
  output: string,
  context?: GuardrailContext
) => Promise<GuardrailResult<string>> | GuardrailResult<string>;

export type ToolGuardrail = (
  toolCall: ToolCall,
  context?: GuardrailContext
) => Promise<GuardrailResult<ToolCall>> | GuardrailResult<ToolCall>;

/**
 * Common Model Provider Interface
 */
export interface ProviderMessage {
  role: Role;
  content: string;
  name?: string;
  toolCalls?: ToolCall[];
  toolResult?: ToolResult;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequest {
  messages: ProviderMessage[];
  systemPrompt?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  outputSchema?: Record<string, unknown>;
  abortSignal?: AbortSignal;
}

export interface ProviderResponse {
  content?: string;
  toolCalls?: ToolCall[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop" | string;
  usage?: TokenUsage;
}

export interface ModelProvider {
  name: string;
  generate(request: ProviderRequest): Promise<ProviderResponse>;
  stream?(
    request: ProviderRequest
  ): AsyncGenerator<ProviderStreamChunk, ProviderResponse, unknown>;
}

export interface ProviderStreamChunk {
  type: "text_delta" | "tool_call_delta";
  text?: string;
  toolCall?: Partial<ToolCall>;
}

/**
 * Session storage interface for raw conversation history.
 */
export interface SessionStore {
  getHistory(sessionId: string): Promise<Message[]>;
  appendMessages(sessionId: string, messages: Message[]): Promise<void>;
  clear(sessionId: string): Promise<void>;
}

/**
 * Long-term Semantic Graph Memory Store interface.
 */
export interface GraphMemoryEntry {
  subject: string;
  predicate: string;
  object: string;
  metadata?: Record<string, unknown>;
}

export interface GraphMemoryQuery {
  about: string;
  limit?: number;
}

export interface GraphMemoryStore {
  remember(entry: GraphMemoryEntry): Promise<void>;
  recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]>;
  close(): Promise<void>;
}

/**
 * Tracing definitions.
 */
export interface TraceSpan {
  id: string;
  parentId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  error?: Record<string, unknown>;
}

export interface Trace {
  runId: string;
  spans: TraceSpan[];
  usage: TokenUsage;
  startTime: number;
  endTime?: number;
}

export interface TraceExporter {
  export(trace: Trace): Promise<void> | void;
}

/**
 * Run options passed to agent.run() or agent.stream()
 */
export interface RunOptions {
  sessionId?: string;
  sessionStore?: SessionStore;
  maxTurns?: number;
  maxHandoffs?: number;
  signal?: AbortSignal;
  onApprovalRequired?: (toolCall: ToolCall) => Promise<boolean> | boolean;
  traceExporter?: TraceExporter;
  initialMessages?: Message[];
}

/**
 * Run Context available for dynamic instructions or hooks.
 */
export interface RunContext {
  runId: string;
  agentName: string;
  sessionId?: string;
  turn: number;
}

/**
 * Agent Configuration.
 */
export interface AgentConfig<TOutput = string> {
  name: string;
  instructions: string | ((context: RunContext) => string | Promise<string>);
  model: ModelProvider;
  tools?: Tool[];
  outputSchema?: z.ZodType<TOutput>;
  inputGuardrails?: InputGuardrail[];
  outputGuardrails?: OutputGuardrail[];
  toolGuardrails?: ToolGuardrail[];
  handoffs?: any[]; // Agent instances
  maxTurns?: number;
  maxHandoffs?: number;
  maxRepairAttempts?: number;
  temperature?: number;
}

/**
 * Typed RunResult returned by agent.run()
 */
export type RunResult<TOutput = string> =
  | {
      success: true;
      output: TOutput;
      messages: Message[];
      usage: TokenUsage;
      agentName: string;
      turns: number;
      trace?: Trace;
    }
  | {
      success: false;
      error: SaguError;
      messages: Message[];
      usage: TokenUsage;
      agentName: string;
      turns: number;
      trace?: Trace;
    };
