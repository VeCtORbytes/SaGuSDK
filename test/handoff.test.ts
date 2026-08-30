import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import { defineTool } from "../src/tool.ts";
import { mock } from "../src/providers/mock.ts";
import { HandoffError } from "../src/errors.ts";
import {
  formatHandoffToolName,
  isHandoffToolName,
  extractTargetAgentName,
} from "../src/handoff.ts";

test("Handoff - utility functions", () => {
  assert.equal(formatHandoffToolName("Billing Agent"), "transfer_to_billing_agent");
  assert.equal(isHandoffToolName("transfer_to_billing_agent"), true);
  assert.equal(isHandoffToolName("get_weather"), false);
  assert.equal(extractTargetAgentName("transfer_to_billing_agent"), "billing_agent");
});

test("Handoff - single handoff from Triage to Specialist", async () => {
  const billingModel = mock(["I have reviewed your billing inquiry. Your last invoice was paid."]);
  const billingAgent = new Agent({
    name: "Billing Specialist",
    instructions: "You handle billing and payment questions.",
    model: billingModel,
  });

  const triageModel = mock([
    {
      toolCalls: [
        {
          id: "call_transfer_1",
          name: "transfer_to_billing_specialist",
          arguments: { reason: "Customer has questions regarding invoice payment." },
        },
      ],
    },
  ]);

  const triageAgent = new Agent({
    name: "Triage Agent",
    instructions: "Route users to the appropriate specialist.",
    model: triageModel,
    handoffs: [billingAgent],
  });

  const res = await triageAgent.run("I need help with my last invoice payment.");

  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output, "I have reviewed your billing inquiry. Your last invoice was paid.");
    assert.equal(res.agentName, "Billing Specialist");
    assert.equal(res.turns, 2);
    assert.equal(res.messages.length, 4);
    assert.equal(res.messages[0]?.role, "user");
    assert.equal(res.messages[1]?.role, "assistant");
    assert.equal(res.messages[1]?.toolCalls?.[0]?.name, "transfer_to_billing_specialist");
    assert.equal(res.messages[2]?.role, "tool");
    assert.equal(res.messages[2]?.toolResult?.name, "transfer_to_billing_specialist");
    assert.equal(res.messages[3]?.role, "assistant");
    assert.equal(res.messages[3]?.content, "I have reviewed your billing inquiry. Your last invoice was paid.");
  }
});

test("Handoff - multi-hop handoff (Triage -> Tier 1 Support -> Database Specialist)", async () => {
  const dbModel = mock(["Database connection reset successfully."]);
  const dbAgent = new Agent({
    name: "DB Admin",
    instructions: "You handle database administrative operations.",
    model: dbModel,
  });

  const tier1Model = mock([
    {
      toolCalls: [
        {
          id: "call_t2",
          name: "transfer_to_db_admin",
          arguments: { reason: "Database error requires DBA intervention." },
        },
      ],
    },
  ]);

  const tier1Agent = new Agent({
    name: "Tier 1 Support",
    instructions: "Handle general tech issues or escalate to DB Admin.",
    model: tier1Model,
    handoffs: [dbAgent],
  });

  const triageModel = mock([
    {
      toolCalls: [
        {
          id: "call_t1",
          name: "transfer_to_tier_1_support",
          arguments: { reason: "Technical issue." },
        },
      ],
    },
  ]);

  const triageAgent = new Agent({
    name: "Triage",
    instructions: "Route incoming tickets.",
    model: triageModel,
    handoffs: [tier1Agent],
  });

  const res = await triageAgent.run("The database is rejecting connections.");

  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.agentName, "DB Admin");
    assert.equal(res.turns, 3);
    assert.equal(res.output, "Database connection reset successfully.");
  }
});

test("Handoff - loop protection triggers HandoffError when maxHandoffs exceeded", async () => {
  // Create two agents that keep handing off to each other
  let agentA: Agent<any>;
  let agentB: Agent<any>;

  const modelA = mock({
    defaultResponse: () => ({
      toolCalls: [{ id: "call_to_b", name: "transfer_to_agent_b", arguments: {} }],
      stopReason: "tool_use",
    }),
  });

  const modelB = mock({
    defaultResponse: () => ({
      toolCalls: [{ id: "call_to_a", name: "transfer_to_agent_a", arguments: {} }],
      stopReason: "tool_use",
    }),
  });

  agentB = new Agent({
    name: "Agent B",
    instructions: "Delegate to Agent A.",
    model: modelB,
    handoffs: [],
  });

  agentA = new Agent({
    name: "Agent A",
    instructions: "Delegate to Agent B.",
    model: modelA,
    handoffs: [agentB],
  });

  // Wire back reference to create loop
  (agentB as any).handoffs = [agentA];

  const res = await agentA.run("Start ping pong", { maxHandoffs: 3 });

  assert.equal(res.success, false);
  if (!res.success) {
    assert(res.error instanceof HandoffError);
    assert.equal(res.error.code, "SAGU_HANDOFF_ERROR");
    assert(res.error.message.includes("Maximum handoffs limit"));
  }
});

test("Handoff - tool execution before and after handoff", async () => {
  const triageLookupTool = defineTool({
    name: "classify_ticket",
    description: "Classify ticket priority",
    input: z.object({ category: z.string() }),
    execute: async ({ category }) => ({ priority: "HIGH", category }),
  });

  const refundTool = defineTool({
    name: "issue_refund",
    description: "Issue a monetary refund",
    input: z.object({ amount: z.number() }),
    execute: async ({ amount }) => ({ refundId: "ref_999", amount, status: "PROCESSED" }),
  });

  const refundSpecialist = new Agent({
    name: "Refund Specialist",
    instructions: "Issue refunds.",
    model: mock([
      {
        toolCalls: [{ id: "call_refund", name: "issue_refund", arguments: { amount: 50 } }],
      },
      "Refund of $50 has been processed successfully.",
    ]),
    tools: [refundTool],
  });

  const triageAgent = new Agent({
    name: "Triage",
    instructions: "Classify and route.",
    model: mock([
      {
        toolCalls: [{ id: "call_classify", name: "classify_ticket", arguments: { category: "billing" } }],
      },
      {
        toolCalls: [{ id: "call_xfer", name: "transfer_to_refund_specialist", arguments: { reason: "High priority refund" } }],
      },
    ]),
    tools: [triageLookupTool],
    handoffs: [refundSpecialist],
  });

  const res = await triageAgent.run("I want my $50 back immediately.");

  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output, "Refund of $50 has been processed successfully.");
    assert.equal(res.agentName, "Refund Specialist");
  }
});
