# Error Handling

SAGU adheres to a strict, predictable error-handling policy designed to eliminate unnecessary `try/catch` boilerplate.

---

## The Return vs. Throw Policy

| Scenario | Behavior | Example |
|---|---|---|
| **Programmer Mistake** | **Throws synchronously** | Invalid agent config, missing tool name, non-function execute |
| **Expected Runtime Outcome** | **Returns `{ success: false, error: SaguError }`** | Guardrail blocked, tool approval denied, max turns reached, schema repair exhausted, provider error |

```typescript
// No try/catch needed for normal agent control flow!
const result = await agent.run("Perform operation");

if (result.success) {
  console.log("Success:", result.output);
} else {
  // Handle expected operational failure cleanly:
  console.warn(`Failed with code ${result.error.code}:`, result.error.message);
}
```

---

## Error Hierarchy

All errors inherit from the base `SaguError`:

```
SaguError
 ├── ConfigurationError           (Invalid agent config or tool definition)
 ├── ProviderError                (LLM API network error, rate limit, or HTTP failure)
 ├── GuardrailError               (Input, output, or tool guardrail blocked execution)
 ├── ToolExecutionError           (Tool threw, timed out, or had approval denied)
 ├── StructuredOutputError        (Output failed schema validation after repairs)
 ├── HandoffError                 (Handoff loop cap or invalid agent transfer)
 ├── TimeoutError                 (Operation or tool exceeded timeoutMs)
 ├── MaxTurnsExceededError        (Agent hit maxTurns limit without final answer)
 └── MemoryError                  (SessionStore or GraphMemoryStore failure)
```

### Error Code Enum (`SaguErrorCode`)
- `SAGU_CONFIG_ERROR`
- `SAGU_PROVIDER_ERROR`
- `SAGU_GUARDRAIL_ERROR`
- `SAGU_TOOL_EXECUTION_ERROR`
- `SAGU_STRUCTURED_OUTPUT_ERROR`
- `SAGU_HANDOFF_ERROR`
- `SAGU_TIMEOUT_ERROR`
- `SAGU_MAX_TURNS_EXCEEDED`
- `SAGU_MEMORY_ERROR`

### Inspecting Error Details
Every `SaguError` contains a `details` object and serializes cleanly via `.toJSON()`:
```typescript
if (!result.success) {
  if (result.error instanceof GuardrailError) {
    console.log("Stage:", result.error.stage);   // "input" | "output" | "tool"
    console.log("Reason:", result.error.reason);
  }
}
```
