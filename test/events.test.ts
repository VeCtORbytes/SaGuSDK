import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import { mock } from "../src/providers/mock.ts";
import { defineTool } from "../src/tool.ts";
import {
  isTextDelta,
  isToolStart,
  isToolEnd,
  isHandoff,
  isGuardrailTriggered,
  isRunCompleted,
  isRunFailed,
  type AgentEvent,
} from "../src/events.ts";

test("Events - agent.stream() yields text_delta and run_completed", async () => {
  const model = mock(["Hello from streaming!"]);
  const agent = new Agent({
    name: "streaming_agent",
    instructions: "Greet the user.",
    model,
  });

  const events: AgentEvent[] = [];
  for await (const event of agent.stream("Hi!")) {
    events.push(event);
  }

  assert(events.length >= 2);
  const textDeltas = events.filter(isTextDelta);
  assert(textDeltas.length > 0);
  const combinedText = textDeltas.map((d) => d.text).join("");
  assert.equal(combinedText, "Hello from streaming!");

  const completed = events.find(isRunCompleted);
  assert(completed);
  assert.equal(completed.output, "Hello from streaming!");
  assert.equal(completed.agentName, "streaming_agent");
  assert(completed.usage.totalTokens > 0);
});

test("Events - agent.stream() yields tool_start and tool_end events", async () => {
  const echoTool = defineTool({
    name: "echo",
    description: "Echo input",
    input: z.object({ text: z.string() }),
    execute: async ({ text }) => ({ echo: text }),
  });

  const model = mock([
    {
      toolCalls: [{ id: "call_echo_1", name: "echo", arguments: { text: "foobar" } }],
    },
    "Echo completed successfully.",
  ]);

  const agent = new Agent({
    name: "tool_agent",
    instructions: "Run tools.",
    model,
    tools: [echoTool],
  });

  const events: AgentEvent[] = [];
  for await (const event of agent.stream("Echo foobar")) {
    events.push(event);
  }

  const toolStarts = events.filter(isToolStart);
  assert.equal(toolStarts.length, 1);
  assert.equal(toolStarts[0]?.name, "echo");
  assert.deepEqual(toolStarts[0]?.arguments, { text: "foobar" });

  const toolEnds = events.filter(isToolEnd);
  assert.equal(toolEnds.length, 1);
  assert.equal(toolEnds[0]?.name, "echo");
  assert.equal(toolEnds[0]?.isError, false);
  assert.deepEqual(toolEnds[0]?.result, { echo: "foobar" });

  const completed = events.find(isRunCompleted);
  assert(completed);
  assert.equal(completed.output, "Echo completed successfully.");
});

test("Events - agent.stream() yields handoff events", async () => {
  const specialist = new Agent({
    name: "Specialist",
    instructions: "Specialist agent.",
    model: mock(["Specialist response"]),
  });

  const triage = new Agent({
    name: "Triage",
    instructions: "Route to specialist.",
    model: mock([
      {
        toolCalls: [
          {
            id: "call_h1",
            name: "transfer_to_specialist",
            arguments: { reason: "Needs domain knowledge" },
          },
        ],
      },
    ]),
    handoffs: [specialist],
  });

  const events: AgentEvent[] = [];
  for await (const event of triage.stream("Help me")) {
    events.push(event);
  }

  const handoffs = events.filter(isHandoff);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0]?.fromAgent, "Triage");
  assert.equal(handoffs[0]?.toAgent, "Specialist");
  assert.equal(handoffs[0]?.reason, "Needs domain knowledge");

  const completed = events.find(isRunCompleted);
  assert(completed);
  assert.equal(completed.agentName, "Specialist");
});

test("Events - agent.stream() yields guardrail_triggered and run_failed on block", async () => {
  const blockInput = async (text: string) => {
    if (text.includes("bad_word")) {
      return { pass: false, reason: "Inappropriate language" };
    }
    return { pass: true };
  };

  const agent = new Agent({
    name: "guarded_agent",
    instructions: "Help user.",
    model: mock(["Ok"]),
    inputGuardrails: [blockInput],
  });

  const events: AgentEvent[] = [];
  for await (const event of agent.stream("This contains bad_word")) {
    events.push(event);
  }

  const guardrailEvents = events.filter(isGuardrailTriggered);
  assert.equal(guardrailEvents.length, 1);
  assert.equal(guardrailEvents[0]?.stage, "input");
  assert.equal(guardrailEvents[0]?.action, "blocked");
  assert.equal(guardrailEvents[0]?.reason, "Inappropriate language");

  const failed = events.find(isRunFailed);
  assert(failed);
  assert.equal(failed.error.code, "SAGU_GUARDRAIL_ERROR");
});
