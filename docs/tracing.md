# Tracing & Observability

SAGU includes built-in distributed tracing that automatically records execution spans without requiring OpenTelemetry or external dependencies.

---

## Span Hierarchy

Every `.run()` generates a structured `Trace` with hierarchical spans:

```
agent_run (Total: 420ms)
 ├─ input_guardrail (2ms)
 ├─ model_call [turn: 1] (180ms)
 ├─ tool_execution [tool: search] (65ms)
 ├─ model_call [turn: 2] (160ms)
 └─ output_guardrail (3ms)
```

Each span captures:
- `id` and `parentId`
- `startTime` and `endTime` (duration)
- `attributes` (tool arguments, stop reasons, model names)
- `error` (stack traces and error codes on failures)

---

## Built-In Exporters

### 1. `ConsoleExporter`
Pretty-prints an ASCII tree of spans, durations, token counts, and execution status:
```typescript
import { Agent, ConsoleExporter, anthropic } from "sagu-sdk";

const agent = new Agent({ name: "Demo", instructions: "Help", model: anthropic() });

await agent.run("What's 2+2?", {
  traceExporter: new ConsoleExporter(),
});
```

Example output:
```
┌─ [SAGU TRACE] Run ID: 48f912ca-bc81 (310ms)
│  Usage: 42 tokens (28 in / 14 out)
│  └─ agent_run (310ms) ✔
│     ├─ model_call (210ms) ✔
│     │     Attrs: {"agent":"Demo","turn":1,"stopReason":"end_turn"}
│     └─ output_guardrail (1ms) ✔
└─────────────────────────────────────────────────────────
```

### 2. `JSONFileExporter`
Writes structured JSON traces to disk for offline analysis or CI/CD debugging:
```typescript
import { JSONFileExporter } from "sagu-sdk";

await agent.run("Run task", {
  traceExporter: new JSONFileExporter({ outputDir: "./traces" }),
});
```

---

## Automatic Secret Redaction

Trace outputs automatically scrub sensitive credentials before exporting:
- API Keys: `sk-...` (OpenAI), `sk-ant-...` (Anthropic), `AIza...` (Gemini)
- HTTP Bearer tokens
- Environment variable values whose names contain `KEY`, `SECRET`, `PASSWORD`, `TOKEN`, or `AUTH`
- Object attributes like `apiKey`, `password`, `secretKey`, etc.
