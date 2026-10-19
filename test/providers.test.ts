import test from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, anthropic } from "../src/providers/anthropic.ts";
import { OpenAIProvider, openai } from "../src/providers/openai.ts";
import { GeminiProvider, gemini } from "../src/providers/gemini.ts";
import { FallbackProvider, fallback } from "../src/providers/fallback.ts";
import { mock } from "../src/providers/mock.ts";
import { ConfigurationError, ProviderError } from "../src/errors.ts";
import type { ProviderRequest } from "../src/providers/types.ts";

test("AnthropicProvider - throws ConfigurationError when apiKey missing", async () => {
  const provider = new AnthropicProvider({ apiKey: "" });
  await assert.rejects(
    async () => {
      await provider.generate({ messages: [{ role: "user", content: "Hi" }] });
    },
    (err: unknown) => {
      assert(err instanceof ConfigurationError);
      assert(err.message.includes("Anthropic API key is missing"));
      return true;
    }
  );
});

test("AnthropicProvider - correctly translates messages, tools, and parses response", async () => {
  let capturedBody: any = null;
  let capturedHeaders: any = null;

  const mockFetch: typeof fetch = async (_url, init) => {
    capturedHeaders = init?.headers;
    capturedBody = JSON.parse(init?.body as string);

    return new Response(
      JSON.stringify({
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [
          { type: "text", text: "I will check the weather." },
          {
            type: "tool_use",
            id: "toolu_abc",
            name: "get_weather",
            input: { city: "Paris" },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 25, output_tokens: 15 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = anthropic({
    apiKey: "test-anthropic-key",
    fetch: mockFetch,
  });

  const request: ProviderRequest = {
    systemPrompt: "You are a helpful assistant.",
    messages: [
      { role: "user", content: "What is the weather in Paris?" },
      {
        role: "assistant",
        content: "Checking...",
        toolCalls: [{ id: "t_prev", name: "check_time", arguments: {} }],
      },
      {
        role: "tool",
        content: "12:00",
        toolResult: { toolCallId: "t_prev", name: "check_time", result: "12:00" },
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Fetch weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    ],
  };

  const response = await provider.generate(request);

  // Validate request translation
  assert.equal(capturedHeaders["x-api-key"], "test-anthropic-key");
  assert.equal(capturedBody.system, "You are a helpful assistant.");
  assert.equal(capturedBody.tools?.length, 1);
  assert.equal(capturedBody.tools[0].name, "get_weather");
  assert.equal(capturedBody.messages[0].role, "user");
  assert.equal(capturedBody.messages[1].role, "assistant");
  assert.equal(capturedBody.messages[2].role, "user"); // Tool result mapped to user message in Anthropic

  // Validate response parsing
  assert.equal(response.content, "I will check the weather.");
  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.name, "get_weather");
  assert.deepEqual(response.toolCalls?.[0]?.arguments, { city: "Paris" });
  assert.equal(response.usage?.totalTokens, 40);
});

test("OpenAIProvider - throws ConfigurationError when apiKey missing", async () => {
  const provider = new OpenAIProvider({ apiKey: "" });
  await assert.rejects(
    async () => {
      await provider.generate({ messages: [{ role: "user", content: "Hi" }] });
    },
    (err: unknown) => {
      assert(err instanceof ConfigurationError);
      assert(err.message.includes("OpenAI API key is missing"));
      return true;
    }
  );
});

test("OpenAIProvider - translates messages and parses tool_calls response", async () => {
  let capturedBody: any = null;

  const mockFetch: typeof fetch = async (_url, init) => {
    capturedBody = JSON.parse(init?.body as string);

    return new Response(
      JSON.stringify({
        id: "chatcmpl_abc",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_calc",
                  type: "function",
                  function: {
                    name: "calculate",
                    arguments: JSON.stringify({ expression: "2+2" }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = openai({
    apiKey: "test-openai-key",
    fetch: mockFetch,
  });

  const response = await provider.generate({
    systemPrompt: "Math assistant",
    messages: [{ role: "user", content: "What is 2+2?" }],
    tools: [
      {
        name: "calculate",
        description: "Math calc",
        parameters: { type: "object", properties: { expression: { type: "string" } } },
      },
    ],
  });

  assert.equal(capturedBody.messages[0].role, "system");
  assert.equal(capturedBody.tools[0].type, "function");
  assert.equal(capturedBody.tools[0].function.name, "calculate");

  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.name, "calculate");
  assert.deepEqual(response.toolCalls?.[0]?.arguments, { expression: "2+2" });
});

test("GeminiProvider - throws ConfigurationError when apiKey missing", async () => {
  const provider = new GeminiProvider({ apiKey: "" });
  await assert.rejects(
    async () => {
      await provider.generate({ messages: [{ role: "user", content: "Hi" }] });
    },
    (err: unknown) => {
      assert(err instanceof ConfigurationError);
      assert(err.message.includes("Gemini API key is missing"));
      return true;
    }
  );
});

test("GeminiProvider - translates contents and parses functionCall candidate", async () => {
  let capturedBody: any = null;
  let capturedUrl = "";

  const mockFetch: typeof fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(init?.body as string);

    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "search_docs",
                    args: { query: "Sagu SDK" },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8, totalTokenCount: 23 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };

  const provider = gemini({
    apiKey: "test-gemini-key",
    fetch: mockFetch,
  });

  const response = await provider.generate({
    messages: [{ role: "user", content: "Search for Sagu" }],
    tools: [
      {
        name: "search_docs",
        description: "Search documentation",
        parameters: { type: "object" },
      },
    ],
  });

  assert(capturedUrl.includes("key=test-gemini-key"));
  assert.equal(capturedBody.tools[0].functionDeclarations[0].name, "search_docs");
  assert.equal(capturedBody.contents[0].parts[0].text, "Search for Sagu");

  assert.equal(response.stopReason, "tool_use");
  assert.equal(response.toolCalls?.length, 1);
  assert.equal(response.toolCalls?.[0]?.name, "search_docs");
  assert.deepEqual(response.toolCalls?.[0]?.arguments, { query: "Sagu SDK" });
  assert.equal(response.usage?.totalTokens, 23);
});

test("FallbackProvider - uses primary when healthy", async () => {
  const primary = mock(["Primary response"]);
  const secondary = mock(["Secondary response"]);

  const provider = fallback(primary, secondary);
  const res = await provider.generate({ messages: [{ role: "user", content: "Hello" }] });

  assert.equal(res.content, "Primary response");
  assert.equal(primary.requests.length, 1);
  assert.equal(secondary.requests.length, 0);
});

test("FallbackProvider - seamlessly switches to fallback when primary fails", async () => {
  const primary = mock([
    {
      error: "Primary API unavailable",
      statusCode: 503,
      isTransient: true,
    },
  ]);
  const secondary = mock(["Secondary took over successfully"]);

  let fallbackLoggedFrom = "";
  let fallbackLoggedTo = "";

  const provider = new FallbackProvider([primary, secondary], {
    onFallback: (from, to) => {
      fallbackLoggedFrom = from;
      fallbackLoggedTo = to;
    },
  });

  const res = await provider.generate({ messages: [{ role: "user", content: "Hello" }] });

  assert.equal(res.content, "Secondary took over successfully");
  assert.equal(fallbackLoggedFrom, primary.name);
  assert.equal(fallbackLoggedTo, secondary.name);
});

test("FallbackProvider - throws ProviderError when all providers fail", async () => {
  const primary = mock([{ error: "Primary down", statusCode: 500 }]);
  const secondary = mock([{ error: "Secondary down", statusCode: 500 }]);

  const provider = fallback(primary, secondary);

  await assert.rejects(
    async () => {
      await provider.generate({ messages: [{ role: "user", content: "Hello" }] });
    },
    (err: unknown) => {
      assert(err instanceof ProviderError);
      assert(err.message.includes("All fallback providers exhausted"));
      return true;
    }
  );
});
