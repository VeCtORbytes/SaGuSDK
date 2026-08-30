import test from "node:test";
import assert from "node:assert/strict";
import { mock, MockProvider } from "../src/providers/mock.ts";
import { ProviderError } from "../src/errors.ts";

test("MockProvider - basic string scripted turns", async () => {
  const provider = mock(["First answer", "Second answer"]);

  const res1 = await provider.generate({ messages: [{ role: "user", content: "Hi" }] });
  assert.equal(res1.content, "First answer");
  assert.equal(res1.stopReason, "end_turn");
  assert(res1.usage && res1.usage.totalTokens > 0);

  const res2 = await provider.generate({ messages: [{ role: "user", content: "Next" }] });
  assert.equal(res2.content, "Second answer");

  // Fallback when queue empty
  const res3 = await provider.generate({ messages: [{ role: "user", content: "Another" }] });
  assert.equal(res3.content, "Mock response");
});

test("MockProvider - tool call generation", async () => {
  const provider = mock([
    {
      toolCalls: [
        {
          id: "call_123",
          name: "get_weather",
          arguments: { city: "San Francisco" },
        },
      ],
    },
    "The weather in San Francisco is sunny.",
  ]);

  const res1 = await provider.generate({
    messages: [{ role: "user", content: "What is the weather in SF?" }],
    tools: [
      {
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object" },
      },
    ],
  });

  assert.equal(res1.stopReason, "tool_use");
  assert.equal(res1.toolCalls?.length, 1);
  assert.equal(res1.toolCalls?.[0]?.name, "get_weather");
  assert.deepEqual(res1.toolCalls?.[0]?.arguments, { city: "San Francisco" });

  const res2 = await provider.generate({
    messages: [
      { role: "user", content: "What is the weather in SF?" },
      { role: "assistant", content: "", toolCalls: res1.toolCalls },
      {
        role: "tool",
        content: JSON.stringify({ temp: 65, condition: "Sunny" }),
        toolResult: { toolCallId: "call_123", name: "get_weather", result: { temp: 65, condition: "Sunny" } },
      },
    ],
  });

  assert.equal(res2.content, "The weather in San Francisco is sunny.");
  assert.equal(res2.stopReason, "end_turn");
});

test("MockProvider - functional turn generator & request inspection", async () => {
  const provider = new MockProvider({
    script: [
      (req) => ({
        content: `Echo: ${req.messages[0]?.content}`,
        stopReason: "end_turn",
      }),
    ],
  });

  const res = await provider.generate({
    messages: [{ role: "user", content: "Ping!" }],
  });

  assert.equal(res.content, "Echo: Ping!");
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.lastRequest?.messages[0]?.content, "Ping!");
});

test("MockProvider - error simulation", async () => {
  const provider = mock([
    {
      error: "Rate limit reached",
      statusCode: 429,
    },
  ]);

  await assert.rejects(
    async () => {
      await provider.generate({ messages: [{ role: "user", content: "Test" }] });
    },
    (err: unknown) => {
      assert(err instanceof ProviderError);
      assert.equal(err.statusCode, 429);
      assert.equal(err.isTransient, true);
      assert.equal(err.provider, "mock");
      return true;
    }
  );
});

test("MockProvider - streaming chunks", async () => {
  const provider = mock([
    {
      content: "Hello streaming world",
      toolCalls: [{ id: "call_abc", name: "calc", arguments: { expr: "1+1" } }],
    },
  ]);

  const stream = provider.stream({
    messages: [{ role: "user", content: "Stream me" }],
  });

  const chunks: string[] = [];
  let toolCallSeen = false;

  for await (const chunk of stream) {
    if (chunk.type === "text_delta" && chunk.text) {
      chunks.push(chunk.text);
    }
    if (chunk.type === "tool_call_delta" && chunk.toolCall?.name === "calc") {
      toolCallSeen = true;
    }
  }

  assert.equal(chunks.join(""), "Hello streaming world");
  assert.equal(toolCallSeen, true);
});
