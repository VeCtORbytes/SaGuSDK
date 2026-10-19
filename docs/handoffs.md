# Multi-Agent Handoffs

In SAGU, complex workflows are split across specialized agents rather than cramming dozens of tools into a single prompt.

---

## How Handoffs Work

When you declare `handoffs: [billingAgent, techAgent]` on an agent, SAGU automatically creates synthetic tools named `transfer_to_<agent_name>`:

```typescript
import { Agent, anthropic } from "sagu-sdk";

// 1. Specialist Agent
const billingSpecialist = new Agent({
  name: "BillingSpecialist",
  instructions: "You handle invoices, refunds, and subscriptions.",
  model: anthropic(),
  tools: [refundTool],
});

// 2. Triage Agent
const triageAgent = new Agent({
  name: "TriageAgent",
  instructions: "Analyze the user's inquiry and transfer to BillingSpecialist when needed.",
  model: anthropic(),
  handoffs: [billingSpecialist],
});
```

When `TriageAgent` calls `transfer_to_billingspecialist`:
1. The runner intercepts the tool call before normal tool execution.
2. Emits an event: `{ type: "handoff", fromAgent: "TriageAgent", toAgent: "BillingSpecialist", reason: "..." }`.
3. Swaps the active agent to `BillingSpecialist`.
4. Passes the entire conversation history forward seamlessly.
5. `BillingSpecialist` evaluates the conversation with its specialized instructions and tools.

---

## Loop Prevention (`maxHandoffs`)

To prevent cyclic infinite ping-pong between agents delegating to each other, SAGU tracks a handoff hop counter:

```typescript
const result = await triageAgent.run("Loop test", {
  maxHandoffs: 5, // Default is 5
});
```

If agents exceed `maxHandoffs`, the run terminates safely and returns `{ success: false, error: HandoffError }` rather than hanging in an infinite loop.
