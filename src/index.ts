/**
 * SAGU SDK — Your open-source, vendor-agnostic AI Agent SDK for TypeScript.
 *
 * A readable 5-minute agent loop that never locks you into a single model vendor.
 */

// Core Agent & Tool
export { Agent } from "./agent.ts";
export { defineTool } from "./tool.ts";
export type { DefineToolOptions } from "./tool.ts";
export { runAgent, streamAgent } from "./runner.ts";

// Providers
export { MockProvider, mock } from "./providers/mock.ts";
export type { MockTurn, MockTurnHandler, MockProviderOptions } from "./providers/mock.ts";
export { AnthropicProvider, anthropic } from "./providers/anthropic.ts";
export type { AnthropicProviderOptions } from "./providers/anthropic.ts";
export { OpenAIProvider, openai } from "./providers/openai.ts";
export type { OpenAIProviderOptions } from "./providers/openai.ts";
export { GeminiProvider, gemini } from "./providers/gemini.ts";
export type { GeminiProviderOptions } from "./providers/gemini.ts";
export { FallbackProvider, fallbackProvider, fallback } from "./providers/fallback.ts";
export type { FallbackOptions } from "./providers/fallback.ts";
export { zodToJsonSchema } from "./providers/schema.ts";

// Guardrails
export {
  createRegexInputGuardrail,
  createRegexOutputGuardrail,
  createLengthGuardrail,
  createToolAllowlistGuardrail,
  createToolParameterGuardrail,
} from "./guardrails.ts";

// Structured Output
export {
  extractJsonFromText,
  formatZodIssues,
  buildSchemaRepairPrompt,
  parseStructuredOutput,
} from "./structuredOutput.ts";

// Multi-Agent Handoffs
export {
  createHandoffTool,
  formatHandoffToolName,
  isHandoffToolName,
  extractTargetAgentName,
  getAgentHandoffTools,
  buildCombinedToolSpecs,
  HANDOFF_TOOL_PREFIX,
  HandoffInputSchema,
} from "./handoff.ts";
export type { HandoffTool, HandoffInput } from "./handoff.ts";

// Memory & Session Stores
export { InMemorySession } from "./memory/inMemory.ts";
export type { InMemorySessionOptions } from "./memory/inMemory.ts";
export { FileSession } from "./memory/file.ts";
export type { FileSessionOptions } from "./memory/file.ts";
export { SqliteSession } from "./memory/sqlite.ts";
export type { SqliteSessionOptions } from "./memory/sqlite.ts";
export {
  InMemoryGraphMemoryStore,
  createAutoGraphMemoryStore,
} from "./memory/graphMemory.ts";
export { Neo4jGraphMemoryStore } from "./memory/neo4jGraphMemory.ts";
export type { Neo4jGraphMemoryOptions } from "./memory/neo4jGraphMemory.ts";
export { createGraphMemoryTools } from "./memory/graphMemoryTools.ts";
export { LongTermMemory } from "./memory/longTermMemory.ts";
export type { LongTermMemoryOptions, RetrievedContext } from "./memory/longTermMemory.ts";
export {
  GraphProcess,
  FactExtractor,
  RelationshipBuilder,
  GraphMaintainer,
  DEFAULT_INFERENCE_RULES,
  DEFAULT_SYMMETRIC_PREDICATES,
  DEFAULT_SINGLE_VALUED_PREDICATES,
} from "./memory/graphProcesses.ts";
export type {
  GraphProcessName,
  GraphProcessOptions,
  ProcessContext,
  GraphUpdate,
  GraphEvent,
  GraphEventListener,
  ConversationInput,
  FactExtractorOptions,
  InferenceRule,
  RelationshipBuilderOptions,
  GraphMaintainerOptions,
} from "./memory/graphProcesses.ts";
export {
  normalizeEntity,
  normalizePredicate,
  entityKey,
  effectiveConfidence,
  reinforceConfidence,
} from "./memory/facts.ts";

// Streaming Events
export {
  isTextDelta,
  isToolStart,
  isToolEnd,
  isHandoff,
  isGuardrailTriggered,
  isRunCompleted,
  isRunFailed,
  isMemoryUpdated,
} from "./events.ts";
export type { AgentEvent } from "./events.ts";

// Tracing & Observability
export {
  TraceRecorder,
  ConsoleExporter,
  JSONFileExporter,
} from "./trace.ts";
export type { JSONFileExporterOptions } from "./trace.ts";

// Reliability
export {
  withRetry,
  withTimeout,
  redactSecrets,
  isTransientError,
} from "./reliability.ts";
export type { RetryOptions } from "./reliability.ts";

// Errors
export {
  SaguError,
  ConfigurationError,
  ProviderError,
  GuardrailError,
  ToolExecutionError,
  StructuredOutputError,
  HandoffError,
  TimeoutError,
  MaxTurnsExceededError,
  MemoryError,
} from "./errors.ts";
export type { SaguErrorCode, GuardrailStage } from "./errors.ts";

// Core Types
export type {
  Role,
  ToolCall,
  ToolResult,
  Message,
  TokenUsage,
  ToolContext,
  Tool,
  GuardrailResult,
  GuardrailContext,
  InputGuardrail,
  OutputGuardrail,
  ToolGuardrail,
  ToolSpec,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamChunk,
  ModelProvider,
  SessionStore,
  GraphMemoryEntry,
  GraphMemoryQuery,
  GraphMemoryStore,
  FactKey,
  LongTermMemoryHook,
  TraceSpan,
  Trace,
  TraceExporter,
  RunOptions,
  RunContext,
  AgentConfig,
  RunResult,
} from "./types.ts";
