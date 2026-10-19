# Guardrails

SAGU provides a three-tier safety verification system to sanitize inputs, prevent model data leaks, and validate tool calls.

---

## 1. Input Guardrails

Input guardrails run **before** user input is submitted to the LLM. They can either **block** the execution or **modify/sanitize** the input text.

```typescript
import { createRegexInputGuardrail, createLengthGuardrail } from "sagu-sdk";

// Block prompt injection attempts
const promptInjectionGuard = createRegexInputGuardrail({
  pattern: /ignore previous instructions/i,
  reason: "Prompt injection detected",
});

// Redact Social Security Numbers
const ssnSanitizer = createRegexInputGuardrail({
  pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  replaceWith: "[REDACTED_SSN]",
});

// Enforce input length
const lengthGuard = createLengthGuardrail({ minLength: 5, maxLength: 500 });
```

---

## 2. Output Guardrails

Output guardrails run **before** the assistant's final response is returned to the user.

```typescript
import { createRegexOutputGuardrail } from "sagu-sdk";

// Prevent leaking API keys or secrets
const secretLeakGuard = createRegexOutputGuardrail({
  pattern: /sk-[a-zA-Z0-9]{20,}/,
  reason: "Model attempted to output an API secret",
});

// Append mandatory compliance disclaimer
const disclaimerGuard = async (output: string) => {
  return { pass: true, modified: `${output}\n\n[Disclaimer: AI-generated response]` };
};
```

---

## 3. Tool Guardrails

Tool guardrails inspect tool calls requested by the model before the tool's `execute()` logic is invoked.

```typescript
import { createToolAllowlistGuardrail, createToolParameterGuardrail } from "sagu-sdk";

// Allow only permitted tools
const allowlistGuard = createToolAllowlistGuardrail(["search", "calculate"]);

// Validate arguments for sensitive tools
const safeTableGuard = createToolParameterGuardrail(
  "delete_record",
  (args: any) => args.table !== "users" && args.table !== "billing",
  "Cannot delete records from protected tables"
);
```

---

## Registering Guardrails on an Agent

```typescript
const agent = new Agent({
  name: "SecureAgent",
  instructions: "Help the user safely.",
  model: anthropic(),
  inputGuardrails: [promptInjectionGuard, ssnSanitizer],
  outputGuardrails: [secretLeakGuard, disclaimerGuard],
  toolGuardrails: [safeTableGuard],
});
```

When a guardrail blocks execution, `agent.run()` cleanly returns `{ success: false, error: GuardrailError }` with the exact stage and reason.
