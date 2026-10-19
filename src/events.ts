import type { Message, TokenUsage, Trace } from "./types.ts";
import type { SaguError } from "./errors.ts";

/**
 * Streaming events emitted by an agent run.
 */
export type AgentEvent<TOutput = any> =
  | {
      type: "text_delta";
      text: string;
    }
  | {
      type: "tool_start";
      toolCallId: string;
      name: string;
      arguments: Record<string, unknown> | string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
      name: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "handoff";
      fromAgent: string;
      toAgent: string;
      reason?: string;
    }
  | {
      type: "guardrail_triggered";
      stage: "input" | "output" | "tool";
      reason: string;
      action: "blocked" | "modified";
      toolName?: string;
    }
  | {
      type: "memory_updated";
      operation: "context_retrieved" | "session_saved" | "conversation_queued";
      count: number;
    }
  | {
      type: "run_completed";
      output: TOutput;
      messages: Message[];
      usage: TokenUsage;
      agentName: string;
      turns: number;
      trace?: Trace;
    }
  | {
      type: "run_failed";
      error: SaguError;
      messages: Message[];
      usage: TokenUsage;
      agentName: string;
      turns: number;
      trace?: Trace;
    };

/**
 * Event type guards
 */
export function isTextDelta(event: AgentEvent): event is { type: "text_delta"; text: string } {
  return event.type === "text_delta";
}

export function isToolStart(event: AgentEvent): event is {
  type: "tool_start";
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown> | string;
} {
  return event.type === "tool_start";
}

export function isToolEnd(event: AgentEvent): event is {
  type: "tool_end";
  toolCallId: string;
  name: string;
  result: unknown;
  isError: boolean;
} {
  return event.type === "tool_end";
}

export function isHandoff(event: AgentEvent): event is {
  type: "handoff";
  fromAgent: string;
  toAgent: string;
  reason?: string;
} {
  return event.type === "handoff";
}

export function isGuardrailTriggered(event: AgentEvent): event is {
  type: "guardrail_triggered";
  stage: "input" | "output" | "tool";
  reason: string;
  action: "blocked" | "modified";
  toolName?: string;
} {
  return event.type === "guardrail_triggered";
}

export function isMemoryUpdated(event: AgentEvent): event is {
  type: "memory_updated";
  operation: "context_retrieved" | "session_saved" | "conversation_queued";
  count: number;
} {
  return event.type === "memory_updated";
}

export function isRunCompleted<T = any>(
  event: AgentEvent<T>
): event is {
  type: "run_completed";
  output: T;
  messages: Message[];
  usage: TokenUsage;
  agentName: string;
  turns: number;
  trace?: Trace;
} {
  return event.type === "run_completed";
}

export function isRunFailed(event: AgentEvent): event is {
  type: "run_failed";
  error: SaguError;
  messages: Message[];
  usage: TokenUsage;
  agentName: string;
  turns: number;
  trace?: Trace;
} {
  return event.type === "run_failed";
}
