import test from "node:test";
import assert from "node:assert/strict";
import { withRetry, withTimeout, redactSecrets, isTransientError } from "../src/reliability.ts";
import { ProviderError, TimeoutError } from "../src/errors.ts";

test("Reliability - withTimeout resolves promptly on fast operation", async () => {
  const result = await withTimeout(
    (async () => {
      await new Promise((r) => setTimeout(r, 20));
      return "done";
    })(),
    1000,
    "fastOp"
  );
  assert.equal(result, "done");
});

test("Reliability - withTimeout rejects with TimeoutError when operation hangs", async () => {
  await assert.rejects(
    async () => {
      await withTimeout(
        new Promise((r) => setTimeout(r, 1000)),
        50,
        "slowOp"
      );
    },
    (err: unknown) => {
      assert(err instanceof TimeoutError);
      assert.equal(err.code, "SAGU_TIMEOUT_ERROR");
      assert.equal(err.operation, "slowOp");
      assert.equal(err.timeoutMs, 50);
      return true;
    }
  );
});

test("Reliability - isTransientError correctly classifies errors", () => {
  const err429 = new ProviderError("Rate limited", { provider: "openai", statusCode: 429 });
  assert.equal(isTransientError(err429), true);

  const err503 = new ProviderError("Service unavailable", { provider: "anthropic", statusCode: 503 });
  assert.equal(isTransientError(err503), true);

  const err400 = new ProviderError("Bad request", { provider: "gemini", statusCode: 400 });
  assert.equal(isTransientError(err400), false);

  const netErr = { code: "ECONNRESET", message: "socket hang up" };
  assert.equal(isTransientError(netErr), true);
});

test("Reliability - withRetry retries transient errors and succeeds", async () => {
  let attempts = 0;
  const retryLog: number[] = [];

  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) {
        throw new ProviderError("Temporary glitch", { provider: "test", statusCode: 429 });
      }
      return "success_after_retries";
    },
    {
      maxRetries: 3,
      initialDelayMs: 20,
      backoffFactor: 1.5,
      onRetry: (_err, _attempt, delay) => {
        retryLog.push(delay);
      },
    }
  );

  assert.equal(result, "success_after_retries");
  assert.equal(attempts, 3);
  assert.equal(retryLog.length, 2);
});

test("Reliability - withRetry does NOT retry non-transient error", async () => {
  let attempts = 0;

  await assert.rejects(
    async () => {
      await withRetry(
        async () => {
          attempts++;
          throw new ProviderError("Authentication failed", { provider: "test", statusCode: 401 });
        },
        { maxRetries: 3, initialDelayMs: 20 }
      );
    },
    (err: unknown) => {
      assert(err instanceof ProviderError);
      assert.equal(err.statusCode, 401);
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test("Reliability - redactSecrets scrubs API keys and sensitive environment values", () => {
  const sampleString =
    "OpenAI: sk-abcdef1234567890abcdef1234567890; Anthropic: sk-ant-api03-abcdef1234567890abcdef12; Gemini: AIzaSyD1234567890abcdef1234567890abcde";

  const scrubbed = redactSecrets(sampleString) as string;
  assert(!scrubbed.includes("sk-abcdef1234567890abcdef1234567890"));
  assert(!scrubbed.includes("sk-ant-api03-abcdef1234567890abcdef12"));
  assert(!scrubbed.includes("AIzaSyD1234567890abcdef1234567890abcde"));
  assert(scrubbed.includes("[REDACTED_SECRET]"));

  // Object scrub
  const obj = {
    apiKey: "my-secret-key-12345",
    nested: {
      password: "adminPassword123",
      safe: "public_value",
    },
    list: ["Bearer abcdef1234567890abcdef"],
  };

  const scrubbedObj = redactSecrets(obj) as any;
  assert.equal(scrubbedObj.apiKey, "[REDACTED_SECRET]");
  assert.equal(scrubbedObj.nested.password, "[REDACTED_SECRET]");
  assert.equal(scrubbedObj.nested.safe, "public_value");
  assert.equal(scrubbedObj.list[0], "[REDACTED_SECRET]");
});
