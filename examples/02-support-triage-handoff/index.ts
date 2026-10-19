import { z } from "zod";
import { Agent, defineTool, mock } from "../../src/index.ts";

/**
 * Example 2: Multi-Agent Customer Support Handoff
 *
 * Demonstrates:
 * 1. Building specialist agents with domain-specific tools
 * 2. Triage routing using synthetic handoff tools (transfer_to_<specialist>)
 * 3. Preserving conversational history across agent boundaries
 * 4. Automatic loop prevention (maxHandoffs)
 */

// 1. Billing Specialist & Tools
const issueRefundTool = defineTool({
  name: "issue_refund",
  description: "Issue a monetary refund to a customer account.",
  input: z.object({
    invoiceId: z.string().describe("Invoice or transaction ID"),
    amount: z.number().describe("Refund amount in USD"),
    reason: z.string().describe("Reason for refund"),
  }),
  execute: async ({ invoiceId, amount, reason }) => {
    return {
      status: "APPROVED",
      refundId: "ref_884920",
      invoiceId,
      amount,
      reason,
      processedAt: new Date().toISOString(),
    };
  },
});

const billingSpecialist = new Agent({
  name: "BillingSpecialist",
  instructions:
    "You are a billing specialist. Assist the user with refunds and payment inquiries using issue_refund.",
  model: mock([
    {
      toolCalls: [
        {
          id: "call_ref_1",
          name: "issue_refund",
          arguments: {
            invoiceId: "INV-9921",
            amount: 79.99,
            reason: "Accidental renewal charge",
          },
        },
      ],
    },
    "I have processed your refund of $79.99 for invoice INV-9921. You will see the credit back on your account in 3-5 business days.",
  ]),
  tools: [issueRefundTool],
});

// 2. Technical Support Specialist
const techSupportSpecialist = new Agent({
  name: "TechSpecialist",
  instructions: "You are a senior technical support engineer. Help resolve API and server connection issues.",
  model: mock(["I have checked the server telemetry and the API endpoints are fully operational."]),
});

// 3. Triage Agent with Handoff Targets
const triageAgent = new Agent({
  name: "TriageAgent",
  instructions:
    "You are the front-desk support triage bot. Determine the customer's request topic and transfer to either BillingSpecialist or TechSpecialist.",
  model: mock([
    {
      toolCalls: [
        {
          id: "call_handoff_1",
          name: "transfer_to_billingspecialist",
          arguments: { reason: "Customer requested a refund for invoice INV-9921" },
        },
      ],
    },
  ]),
  handoffs: [billingSpecialist, techSupportSpecialist],
});

async function main() {
  console.log("=== Sagu SDK: Example 02 - Multi-Agent Support Handoff ===");
  console.log("User: Hi, I was accidentally charged $79.99 on invoice INV-9921 and would like a refund please.");

  // Stream events to observe handoffs in real-time
  console.log("\nStreaming execution events:");
  for await (const event of triageAgent.stream(
    "Hi, I was accidentally charged $79.99 on invoice INV-9921 and would like a refund please."
  )) {
    if (event.type === "handoff") {
      console.log(`\n🔀 [HANDOFF EVENT] Transferred from ${event.fromAgent} -> ${event.toAgent} (Reason: ${event.reason})`);
    } else if (event.type === "tool_start") {
      console.log(`⚙️  [TOOL START] Tool: ${event.name} | Args: ${JSON.stringify(event.arguments)}`);
    } else if (event.type === "tool_end") {
      console.log(`✔  [TOOL END] Tool: ${event.name} | Result: ${JSON.stringify(event.result)}`);
    } else if (event.type === "run_completed") {
      console.log(`\n🎉 [FINAL OUTPUT from ${event.agentName}]:\n${event.output}`);
      console.log(`Turns: ${event.turns} | Total Tokens: ${event.usage.totalTokens}`);
    }
  }
}

main().catch(console.error);
