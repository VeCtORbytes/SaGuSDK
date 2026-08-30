import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import { defineTool } from "../src/tool.ts";
import { mock } from "../src/providers/mock.ts";
import { ConfigurationError, MaxTurnsExceededError } from "../src/errors.ts";

test("Agent - constructor validation", () => {
  const model = mock();

  // Missing name
  assert.throws(
    () => new Agent({ name: "", instructions: "inst", model }),
    ConfigurationError
  );

  // Missing instructions
  assert.throws(
    () => new Agent({ name: "test", instructions: "" as any, model }),
    ConfigurationError
  );

  // Missing model
  assert.throws(
    () => new Agent({ name: "test", instructions: "inst", model: null as any }),
    ConfigurationError
  );
});

test("Agent - single turn text conversation", async () => {
  const model = mock(["Hello! I am ready to help you."]);
  const agent = new Agent({
    name: "assistant",
    instructions: "You are a helpful assistant.",
    model,
  });

  const res = await agent.run("Hi there!");
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output, "Hello! I am ready to help you.");
    assert.equal(res.agentName, "assistant");
    assert.equal(res.turns, 1);
    assert.equal(res.messages.length, 2);
    assert.equal(res.messages[0]?.role, "user");
    assert.equal(res.messages[0]?.content, "Hi there!");
    assert.equal(res.messages[1]?.role, "assistant");
    assert.equal(res.messages[1]?.content, "Hello! I am ready to help you.");
    assert(res.usage.totalTokens > 0);
  }
});

test("Agent - tool execution round-trip", async () => {
  const calculatorTool = defineTool({
    name: "add",
    description: "Add two numbers",
    input: z.object({
      a: z.number().describe("First number"),
      b: z.number().describe("Second number"),
    }),
    execute: async ({ a, b }) => {
      return { result: a + b };
    },
  });

  const model = mock([
    {
      toolCalls: [
        {
          id: "call_add_1",
          name: "add",
          arguments: { a: 40, b: 2 },
        },
      ],
    },
    "The sum of 40 and 2 is 42.",
  ]);

  const agent = new Agent({
    name: "math_agent",
    instructions: "You are a math tutor.",
    model,
    tools: [calculatorTool],
  });

  const res = await agent.run("What is 40 + 2?");
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output, "The sum of 40 and 2 is 42.");
    assert.equal(res.turns, 2);
    assert.equal(res.messages.length, 4);
    assert.equal(res.messages[0]?.role, "user");
    assert.equal(res.messages[1]?.role, "assistant");
    assert.equal(res.messages[1]?.toolCalls?.[0]?.name, "add");
    assert.equal(res.messages[2]?.role, "tool");
    assert.equal(res.messages[2]?.toolResult?.name, "add");
    assert.deepEqual(res.messages[2]?.toolResult?.result, { result: 42 });
    assert.equal(res.messages[3]?.role, "assistant");
    assert.equal(res.messages[3]?.content, "The sum of 40 and 2 is 42.");
  }
});

test("Agent - tool execution handles argument parsing & schema failure gracefully", async () => {
  const tool = defineTool({
    name: "lookup_user",
    description: "Lookup a user by id",
    input: z.object({
      userId: z.string(),
    }),
    execute: async ({ userId }) => ({ userId, found: true }),
  });

  const model = mock([
    // Model sends invalid arguments (number instead of string or missing field)
    {
      toolCalls: [
        {
          id: "call_bad",
          name: "lookup_user",
          arguments: { wrongField: 123 },
        },
      ],
    },
    "I could not find the user because the userId was missing.",
  ]);

  const agent = new Agent({
    name: "user_agent",
    instructions: "Lookup users",
    model,
    tools: [tool],
  });

  const res = await agent.run("Find user");
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.turns, 2);
    assert.equal(res.messages[2]?.role, "tool");
    assert.equal(res.messages[2]?.toolResult?.isError, true);
    assert(String(res.messages[2]?.toolResult?.result).includes("Schema validation failed"));
  }
});

test("Agent - maxTurns cutoff returns { success: false, error: MaxTurnsExceededError }", async () => {
  const infiniteTool = defineTool({
    name: "loop_tool",
    description: "Looping tool",
    input: z.object({}),
    execute: async () => ({ status: "ok" }),
  });

  // Model keeps calling tool indefinitely
  const model = mock({
    defaultResponse: () => ({
      toolCalls: [{ id: "call_inf", name: "loop_tool", arguments: {} }],
      stopReason: "tool_use",
    }),
  });

  const agent = new Agent({
    name: "looping_agent",
    instructions: "Loop forever",
    model,
    tools: [infiniteTool],
    maxTurns: 3,
  });

  const res = await agent.run("Start looping");
  assert.equal(res.success, false);
  if (!res.success) {
    assert(res.error instanceof MaxTurnsExceededError);
    assert.equal(res.error.code, "SAGU_MAX_TURNS_EXCEEDED");
    assert.equal(res.turns, 3);
  }
});

test("Agent - dynamic system instructions function", async () => {
  let evaluatedAgentName = "";
  const agent = new Agent({
    name: "dynamic_agent",
    instructions: async (ctx) => {
      evaluatedAgentName = ctx.agentName;
      return `Current agent is ${ctx.agentName}, turn is ${ctx.turn}`;
    },
    model: mock(["Acknowledged."]),
  });

  const res = await agent.run("Check instructions");
  assert.equal(res.success, true);
  assert.equal(evaluatedAgentName, "dynamic_agent");
});
