/**
 * Sagu SDK Error Hierarchy
 *
 * Core philosophy:
 * - Programmer errors (bad config, missing required params) THROW synchronously.
 * - Runtime execution issues (guardrail trips, max turns reached, timeouts, model errors)
 *   are wrapped in typed SaguErrors and returned via `{ success: false, error }` from `run()`.
 */

export type SaguErrorCode =
  | "SAGU_CONFIG_ERROR"
  | "SAGU_PROVIDER_ERROR"
  | "SAGU_GUARDRAIL_ERROR"
  | "SAGU_TOOL_EXECUTION_ERROR"
  | "SAGU_STRUCTURED_OUTPUT_ERROR"
  | "SAGU_HANDOFF_ERROR"
  | "SAGU_TIMEOUT_ERROR"
  | "SAGU_MAX_TURNS_EXCEEDED"
  | "SAGU_MEMORY_ERROR";

export class SaguError extends Error {
  readonly code: SaguErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: SaguErrorCode, details?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

/**
 * Thrown when the agent or SDK is misconfigured by the developer.
 */
export class ConfigurationError extends SaguError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "SAGU_CONFIG_ERROR", details);
  }
}

/**
 * Returned or thrown when a model provider encounters an error.
 */
export class ProviderError extends SaguError {
  readonly provider: string;
  readonly statusCode?: number;
  readonly isTransient: boolean;

  constructor(
    message: string,
    options: {
      provider: string;
      statusCode?: number;
      isTransient?: boolean;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, "SAGU_PROVIDER_ERROR", options.details);
    this.provider = options.provider;
    this.statusCode = options.statusCode;
    this.isTransient = options.isTransient ?? (options.statusCode === 429 || (options.statusCode !== undefined && options.statusCode >= 500));
  }
}

/**
 * Returned when an input, output, or tool guardrail blocks execution.
 */
export type GuardrailStage = "input" | "output" | "tool";

export class GuardrailError extends SaguError {
  readonly stage: GuardrailStage;
  readonly reason: string;

  constructor(stage: GuardrailStage, reason: string, details?: Record<string, unknown>) {
    super(`Guardrail blocked at '${stage}' stage: ${reason}`, "SAGU_GUARDRAIL_ERROR", {
      stage,
      reason,
      ...details,
    });
    this.stage = stage;
    this.reason = reason;
  }
}

/**
 * Returned when a tool execution fails, times out, or is rejected by human-in-the-loop.
 */
export class ToolExecutionError extends SaguError {
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly isApprovalDenied: boolean;
  readonly isTimeout: boolean;

  constructor(
    message: string,
    options: {
      toolName: string;
      toolCallId?: string;
      isApprovalDenied?: boolean;
      isTimeout?: boolean;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, "SAGU_TOOL_EXECUTION_ERROR", options.details);
    this.toolName = options.toolName;
    this.toolCallId = options.toolCallId;
    this.isApprovalDenied = options.isApprovalDenied ?? false;
    this.isTimeout = options.isTimeout ?? false;
  }
}

/**
 * Returned when structured output cannot be parsed into the expected Zod schema
 * even after repair retry attempts.
 */
export class StructuredOutputError extends SaguError {
  readonly rawOutput: string;
  readonly zodIssues?: unknown[];
  readonly attempts: number;

  constructor(
    message: string,
    options: {
      rawOutput: string;
      zodIssues?: unknown[];
      attempts: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, "SAGU_STRUCTURED_OUTPUT_ERROR", options.details);
    this.rawOutput = options.rawOutput;
    this.zodIssues = options.zodIssues;
    this.attempts = options.attempts;
  }
}

/**
 * Returned when a multi-agent handoff fails (e.g. max handoffs exceeded or invalid agent).
 */
export class HandoffError extends SaguError {
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly hopCount?: number;

  constructor(
    message: string,
    options: {
      fromAgent: string;
      toAgent: string;
      hopCount?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message, "SAGU_HANDOFF_ERROR", options.details);
    this.fromAgent = options.fromAgent;
    this.toAgent = options.toAgent;
    this.hopCount = options.hopCount;
  }
}

/**
 * Returned when an operation exceeds its specified timeout.
 */
export class TimeoutError extends SaguError {
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(operation: string, timeoutMs: number, details?: Record<string, unknown>) {
    super(`Operation '${operation}' timed out after ${timeoutMs}ms`, "SAGU_TIMEOUT_ERROR", {
      operation,
      timeoutMs,
      ...details,
    });
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Returned when the agent loop hits maxTurns without reaching a final answer.
 */
export class MaxTurnsExceededError extends SaguError {
  readonly maxTurns: number;

  constructor(maxTurns: number, details?: Record<string, unknown>) {
    super(`Agent loop reached maximum turns limit (${maxTurns}) without completing`, "SAGU_MAX_TURNS_EXCEEDED", {
      maxTurns,
      ...details,
    });
    this.maxTurns = maxTurns;
  }
}

/**
 * Thrown or returned when session storage or graph memory operations fail.
 */
export class MemoryError extends SaguError {
  readonly store: string;
  readonly operation: string;

  constructor(store: string, operation: string, message: string, details?: Record<string, unknown>) {
    super(`Memory error in ${store}.${operation}: ${message}`, "SAGU_MEMORY_ERROR", {
      store,
      operation,
      ...details,
    });
    this.store = store;
    this.operation = operation;
  }
}
