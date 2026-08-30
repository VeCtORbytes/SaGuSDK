import test from "node:test";
import assert from "node:assert/strict";
import {
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
} from "../src/errors.ts";

test("Error Hierarchy - Base SaguError", () => {
  const err = new SaguError("Something failed", "SAGU_CONFIG_ERROR", { detail: 123 });
  assert.equal(err.name, "SaguError");
  assert.equal(err.code, "SAGU_CONFIG_ERROR");
  assert.equal(err.message, "Something failed");
  assert.deepEqual(err.details, { detail: 123 });
  assert.deepEqual(err.toJSON(), {
    name: "SaguError",
    code: "SAGU_CONFIG_ERROR",
    message: "Something failed",
    details: { detail: 123 },
  });
});

test("Error Hierarchy - ConfigurationError", () => {
  const err = new ConfigurationError("Missing key");
  assert.equal(err.name, "ConfigurationError");
  assert.equal(err.code, "SAGU_CONFIG_ERROR");
  assert(err instanceof SaguError);
});

test("Error Hierarchy - ProviderError transient detection", () => {
  const err429 = new ProviderError("Rate limit exceeded", { provider: "openai", statusCode: 429 });
  assert.equal(err429.code, "SAGU_PROVIDER_ERROR");
  assert.equal(err429.provider, "openai");
  assert.equal(err429.statusCode, 429);
  assert.equal(err429.isTransient, true);

  const err503 = new ProviderError("Service unavailable", { provider: "anthropic", statusCode: 503 });
  assert.equal(err503.isTransient, true);

  const err400 = new ProviderError("Invalid request", { provider: "gemini", statusCode: 400 });
  assert.equal(err400.isTransient, false);
});

test("Error Hierarchy - GuardrailError", () => {
  const err = new GuardrailError("input", "Prompt injection detected");
  assert.equal(err.code, "SAGU_GUARDRAIL_ERROR");
  assert.equal(err.stage, "input");
  assert.equal(err.reason, "Prompt injection detected");
  assert(err.message.includes("input"));
});

test("Error Hierarchy - ToolExecutionError", () => {
  const err = new ToolExecutionError("Denied by user", {
    toolName: "delete_db",
    isApprovalDenied: true,
  });
  assert.equal(err.code, "SAGU_TOOL_EXECUTION_ERROR");
  assert.equal(err.toolName, "delete_db");
  assert.equal(err.isApprovalDenied, true);
});

test("Error Hierarchy - StructuredOutputError", () => {
  const err = new StructuredOutputError("Schema failed", {
    rawOutput: "{ foo: }",
    attempts: 2,
  });
  assert.equal(err.code, "SAGU_STRUCTURED_OUTPUT_ERROR");
  assert.equal(err.rawOutput, "{ foo: }");
  assert.equal(err.attempts, 2);
});

test("Error Hierarchy - HandoffError", () => {
  const err = new HandoffError("Max handoffs reached", {
    fromAgent: "triage",
    toAgent: "billing",
    hopCount: 5,
  });
  assert.equal(err.code, "SAGU_HANDOFF_ERROR");
  assert.equal(err.fromAgent, "triage");
  assert.equal(err.toAgent, "billing");
  assert.equal(err.hopCount, 5);
});

test("Error Hierarchy - TimeoutError & MaxTurnsExceededError & MemoryError", () => {
  const timeout = new TimeoutError("web_search", 5000);
  assert.equal(timeout.code, "SAGU_TIMEOUT_ERROR");
  assert.equal(timeout.timeoutMs, 5000);

  const maxTurns = new MaxTurnsExceededError(10);
  assert.equal(maxTurns.code, "SAGU_MAX_TURNS_EXCEEDED");
  assert.equal(maxTurns.maxTurns, 10);

  const mem = new MemoryError("SqliteSession", "appendMessages", "Disk full");
  assert.equal(mem.code, "SAGU_MEMORY_ERROR");
  assert.equal(mem.store, "SqliteSession");
});
