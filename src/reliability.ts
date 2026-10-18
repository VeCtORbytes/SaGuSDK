import { TimeoutError, ProviderError } from "./errors.ts";

export interface RetryOptions {
  /** Maximum number of retry attempts. Defaults to 3. */
  maxRetries?: number;
  /** Initial delay before first retry in ms. Defaults to 200. */
  initialDelayMs?: number;
  /** Maximum delay cap in ms. Defaults to 4000. */
  maxDelayMs?: number;
  /** Backoff multiplier factor. Defaults to 2. */
  backoffFactor?: number;
  /** Custom predicate to determine whether an error is transient/retryable. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Optional callback invoked on each retry. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Standard transient error check.
 * Retries on:
 * - ProviderError with isTransient === true
 * - HTTP status codes: 429, 500, 502, 503, 504
 * - Network-related errors (ECONNRESET, ETIMEDOUT, fetch failed)
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ProviderError) {
    if (error.isTransient) return true;
    if (error.statusCode !== undefined) {
      return (
        error.statusCode === 429 ||
        error.statusCode === 500 ||
        error.statusCode === 502 ||
        error.statusCode === 503 ||
        error.statusCode === 504
      );
    }
  }

  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    const code = String(err.code || "");
    const msg = String(err.message || "").toLowerCase();

    if (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EAI_AGAIN" ||
      code === "ECONNREFUSED"
    ) {
      return true;
    }

    if (
      msg.includes("rate limit") ||
      msg.includes("too many requests") ||
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("overloaded")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Executes a function with exponential backoff and jitter on transient errors.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const initialDelay = options.initialDelayMs ?? 200;
  const maxDelay = options.maxDelayMs ?? 4000;
  const backoffFactor = options.backoffFactor ?? 2;
  const shouldRetry = options.shouldRetry ?? isTransientError;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: unknown) {
      attempt++;
      if (attempt > maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }

      // Calculate exponential backoff with full jitter
      const rawDelay = Math.min(maxDelay, initialDelay * Math.pow(backoffFactor, attempt - 1));
      const jitterDelay = Math.round(rawDelay * (0.8 + Math.random() * 0.4));

      if (options.onRetry) {
        options.onRetry(err, attempt, jitterDelay);
      }

      await new Promise((resolve) => setTimeout(resolve, jitterDelay));
    }
  }
}

/**
 * Wraps a promise with a timeout. If the promise does not resolve within timeoutMs,
 * it rejects with a TimeoutError and cleans up timers.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
  signal?: AbortSignal
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }

  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(operationName, timeoutMs));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new TimeoutError(`${operationName} (aborted)`, timeoutMs));
      } else {
        abortListener = () => {
          if (timer) clearTimeout(timer);
          reject(new TimeoutError(`${operationName} (aborted)`, timeoutMs));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
    }
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
    }
  }
}

/**
 * Common patterns for secret API keys and tokens.
 */
const DEFAULT_SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/g, // OpenAI & compatible
  /sk-ant-[a-zA-Z0-9_-]{20,}/g, // Anthropic
  /AIza[0-9A-Za-z-_]{30,}/g, // Google Gemini / Cloud
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi, // Authorization Bearer headers
];

function isSensitiveKeyName(key: string): boolean {
  const lower = key.toLowerCase();
  // Exclude token metrics (promptTokens, completionTokens, totalTokens, maxTokens, etc.)
  if (lower.includes("tokens")) {
    return false;
  }
  return (
    lower === "token" ||
    lower.endsWith("_token") ||
    lower.startsWith("token_") ||
    lower.includes("secret") ||
    lower.includes("password") ||
    lower.includes("apikey") ||
    lower.includes("api_key") ||
    lower === "key" ||
    lower.endsWith("_key") ||
    lower.includes("authorization") ||
    lower.includes("auth_header")
  );
}

/**
 * Redacts secrets and API keys from strings, objects, and trace attributes.
 */
export function redactSecrets(value: unknown, customPatterns?: RegExp[]): unknown {
  if (typeof value === "string") {
    let result = value;

    // Apply regex patterns
    const patterns = customPatterns ?? DEFAULT_SECRET_PATTERNS;
    for (const pattern of patterns) {
      result = result.replace(pattern, "[REDACTED_SECRET]");
    }

    // Also check sensitive values from process.env (longer than 8 chars to avoid false positives)
    if (typeof process !== "undefined" && process.env) {
      for (const [key, val] of Object.entries(process.env)) {
        if (val && val.length >= 8 && isSensitiveKeyName(key)) {
          if (result.includes(val)) {
            result = result.split(val).join("[REDACTED_SECRET]");
          }
        }
      }
    }

    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, customPatterns));
  }

  if (value !== null && typeof value === "object") {
    const redactedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveKeyName(k)) {
        redactedObj[k] = "[REDACTED_SECRET]";
      } else {
        redactedObj[k] = redactSecrets(v, customPatterns);
      }
    }
    return redactedObj;
  }

  return value;
}
