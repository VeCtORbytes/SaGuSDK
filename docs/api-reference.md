# API Reference

Comprehensive reference of all public exports from `sagu-sdk`.

---

## Core

### `Agent<TOutput = string>`
Encapsulates an immutable agent configuration.
- `constructor(config: AgentConfig<TOutput>)`
- `run(input: string, options?: RunOptions): Promise<RunResult<TOutput>>`
- `stream(input: string, options?: RunOptions): AsyncGenerator<AgentEvent<TOutput>, void, unknown>`

### `defineTool(options: DefineToolOptions): Tool`
Creates a validated tool with Zod schema and JSON schema generation.
- Options: `{ name, description, input: z.ZodType, execute, requiresApproval?, timeoutMs? }`

---

## Providers

### `mock(turns?: MockTurn[] | MockProviderOptions): MockProvider`
Creates a deterministic mock provider with zero network overhead.

### `anthropic(options?: AnthropicProviderOptions): AnthropicProvider`
Claude Messages API adapter.
- Options: `{ apiKey?, model?, baseURL?, anthropicVersion?, fetch? }`

### `openai(options?: OpenAIProviderOptions): OpenAIProvider`
OpenAI Chat Completions adapter.
- Options: `{ apiKey?, model?, baseURL?, organization?, fetch? }`

### `gemini(options?: GeminiProviderOptions): GeminiProvider`
Google Gemini API adapter.
- Options: `{ apiKey?, model?, baseURL?, fetch? }`

### `fallback(primary: ModelProvider, ...fallbacks: ModelProvider[]): FallbackProvider`
Chained provider that falls back to subsequent providers upon errors.

---

## Guardrails

- `createRegexInputGuardrail({ pattern, reason?, replaceWith? }): InputGuardrail`
- `createRegexOutputGuardrail({ pattern, reason?, replaceWith? }): OutputGuardrail`
- `createLengthGuardrail({ minLength?, maxLength? }): (text: string) => GuardrailResult`
- `createToolAllowlistGuardrail(allowedNames: string[]): ToolGuardrail`
- `createToolParameterGuardrail(toolName, validator, reason?): ToolGuardrail`

---

## Memory & Sessions

- `new InMemorySession(options?: { maxMessagesPerSession? })`
- `new FileSession(options?: { storageDir? })`
- `new SqliteSession(options?: { filename? })` — Uses built-in `node:sqlite`
- `new InMemoryGraphMemoryStore()` — In-memory semantic graph
- `new Neo4jGraphMemoryStore(options: { uri, username?, password?, database? })`
- `createAutoGraphMemoryStore(): Promise<GraphMemoryStore>` — Auto-selects Neo4j or InMemory
- `createGraphMemoryTools(store: GraphMemoryStore): Tool[]` — Returns `[remember_fact, recall_facts]`

---

## Tracing & Reliability

- `TraceRecorder`: Records span trees, token usage, and produces redacted traces.
- `ConsoleExporter`: Pretty-prints trace hierarchy to terminal.
- `JSONFileExporter`: Saves trace JSON files to disk.
- `withRetry<T>(fn, options?): Promise<T>`: Exponential backoff with jitter on transient errors.
- `withTimeout<T>(promise, timeoutMs, opName, signal?): Promise<T>`: Timeout protection.
- `redactSecrets(value, customPatterns?): unknown`: Secret scrubber for API keys & tokens.
