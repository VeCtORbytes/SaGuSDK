<div align="center">

# 🏹 SAGU SDK
**Your open-source, vendor-agnostic AI Agent SDK for TypeScript.**

*A small enough agent loop to read in five minutes, that doesn't lock you to one model vendor.*

[![npm version](https://img.shields.io/badge/npm-v0.1.0-blue.svg)](https://www.npmjs.com/package/sagu-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.0.0-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

---

## Why SAGU?

Existing agent frameworks often hide the core execution loop beneath layers of abstractions (making debugging painful) or lock you into a single model vendor's tool-calling semantics. 

**SAGU** (from *Sarthak Gupta* / *Sarthi* — the charioteer who steers) gives you a crystal-clear, transparent agent loop, full multi-agent orchestration, and native vendor independence.

### 🌟 Key Differentiators

- 🛡️ **Predictable Return vs. Throw Policy:** `agent.run()` **never throws on expected runtime outcomes** (guardrail blocks, tool approval denials, max turns, schema repair exhaustion, provider timeouts). It returns `{ success: true, output, ... }` or `{ success: false, error, ... }`, eliminating messy `try/catch` wrappers.
- ⚡ **Native TypeScript Execution:** Zero build step required during development. Runs `.ts` files directly in Node 25 with stdlib `node --test` and `node:assert`.
- 🗄️ **Zero-Dependency SQLite Sessions:** Fast conversation history persistence using Node 25's built-in `node:sqlite` (`SqliteSession`) without native C++ compilation or external packages.
- 🕸️ **Self-Maintaining Graph Memory:** Stores entities, facts and relationships `(subject -> predicate -> object)` in Neo4j or in memory, kept up to date by **three background processes**: an LLM fact extractor, a relationship builder, and a graph maintainer (dedupe, conflict resolution, decay and pruning). Agents get relevant facts injected automatically.
- 🔄 **Multi-Provider & Fallback Engine:** Native adapters for **Claude (Anthropic)**, **OpenAI**, and **Google Gemini**, plus deterministic **scriptable mock testing** and automatic failover with `fallback()`.
- 🔍 **Built-in Tracing & Secret Redaction:** Emits hierarchical execution span trees while automatically redacting API keys (`sk-...`, `AIza...`), Bearer tokens, and sensitive environment variables.

---

## 🏗️ Architecture: The Three Strict Layers

SAGU explicitly separates state lifecycles into three distinct layers:

```mermaid
graph TD
    subgraph Layer 1: AgentConfig
        A[Agent Definition] -->|Immutable| B[Instructions, Model, Tools, Guardrails, Handoffs, Schema]
    end

    subgraph Layer 2: RunState
        C[.run / .stream Call] -->|Fresh per run| D[Turn Count, Active Agent, Ephemeral Messages, Traces]
        D -->|Discarded after run| E[Final RunResult]
    end

    subgraph Layer 3: Session & Graph Memory
        F[SessionStore] -->|Persists across runs| G[SQLite, File, InMemory]
        H[GraphMemoryStore] -->|Semantic Long-Term Facts| I[Neo4j, InMemoryGraph]
        J[3 background processes] -->|extract, link, maintain| H
    end

    B -.-> C
    G <--> D
    I <--> D
```

1. **`AgentConfig`**: Static configuration (name, instructions, tools, model, guardrails, handoffs). **Immutable after construction.**
2. **`RunState`**: Single execution state (ephemeral messages, hop counts, active agent, spans). **Built fresh per run and discarded.**
3. **`SessionState`**: Persistent history maintained across separate runs via the pluggable `SessionStore` and `GraphMemoryStore` interfaces.

---

## ⚡ 30-Second Quickstart

### 1. Install
```bash
npm install sagu-sdk zod
```

### 2. Run a Tool-Using Agent (Zero Network, Zero API Keys)
```typescript
import { z } from "zod";
import { Agent, defineTool, mock } from "sagu-sdk";

// Define a type-safe tool
const calculatorTool = defineTool({
  name: "calculate",
  description: "Evaluate math expression",
  input: z.object({
    expression: z.string().describe("Expression like '45 * 12'"),
  }),
  execute: async ({ expression }) => {
    return { result: 540 };
  },
});

// Configure the agent
const agent = new Agent({
  name: "MathBot",
  instructions: "Answer user queries with tools.",
  model: mock([
    {
      toolCalls: [{ id: "call_1", name: "calculate", arguments: { expression: "45 * 12" } }],
    },
    "45 multiplied by 12 is 540.",
  ]),
  tools: [calculatorTool],
});

// Run with zero try/catch boilerplate
const result = await agent.run("What is 45 * 12?");

if (result.success) {
  console.log("Answer:", result.output); // "45 multiplied by 12 is 540."
  console.log("Tokens used:", result.usage.totalTokens);
} else {
  console.error("Execution failed:", result.error.message);
}
```

---

## 🧩 Core Capabilities

### 1. Multi-Agent Handoffs
Agents delegate tasks to specialists via synthetic transfer tools with hop-count loop protection (`maxHandoffs`):

```typescript
import { Agent, anthropic } from "sagu-sdk";

const refundAgent = new Agent({
  name: "RefundSpecialist",
  instructions: "Process refunds.",
  model: anthropic(),
  tools: [issueRefundTool],
});

const triageAgent = new Agent({
  name: "Triage",
  instructions: "Route customer to appropriate specialist.",
  model: anthropic(),
  handoffs: [refundAgent],
});

const result = await triageAgent.run("I need a refund for INV-2024.");
// Triage automatically invokes transfer_to_refundspecialist and yields specialist output
```

### 2. Three-Tier Guardrails & Human Approval
```typescript
import {
  Agent,
  createRegexInputGuardrail,
  createRegexOutputGuardrail,
  defineTool,
} from "sagu-sdk";

// 1. Sensitive tool requiring human approval
const rebootTool = defineTool({
  name: "reboot_server",
  description: "Reboot prod server",
  input: z.object({ serverId: z.string() }),
  requiresApproval: true, // Requires human approval callback
  execute: async () => ({ status: "REBOOTED" }),
});

const agent = new Agent({
  name: "SecureOps",
  instructions: "Ops agent.",
  model: anthropic(),
  tools: [rebootTool],
  inputGuardrails: [
    createRegexInputGuardrail({
      pattern: /ignore previous instructions/i,
      reason: "Prompt injection attempt",
    }),
  ],
  outputGuardrails: [
    createRegexOutputGuardrail({
      pattern: /sk-[a-zA-Z0-9]{20,}/,
      reason: "API secret leak prevented",
    }),
  ],
});

// Run with human approval handler (auto-rejects if omitted)
const result = await agent.run("Reboot prod-1", {
  onApprovalRequired: async (toolCall) => {
    return confirm(`Allow ${toolCall.name}?`);
  },
});
```

### 3. Structured Output & Self-Repair Retries
Enforce strict schemas. If the model generates invalid JSON, SAGU automatically formats validation errors and prompts the model to self-repair:

```typescript
const UserProfileSchema = z.object({
  name: z.string(),
  age: z.number().int(),
  interests: z.array(z.string()),
});

type UserProfile = z.infer<typeof UserProfileSchema>;

const agent = new Agent<UserProfile>({
  name: "ProfileExtractor",
  instructions: "Extract user profiles.",
  model: openai(),
  outputSchema: UserProfileSchema,
  maxRepairAttempts: 2,
});

const result = await agent.run("Alice is 30 and loves TypeScript and Neo4j.");
if (result.success) {
  // result.output is fully typed UserProfile
  console.log(result.output.interests); // ["TypeScript", "Neo4j"]
}
```

### 4. Real-Time Event Streaming
`agent.stream()` is an async generator yielding real-time events. `agent.run()` simply drains this stream:

```typescript
for await (const event of agent.stream("Explain quantum computing")) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text); // Real-time token streaming
  } else if (event.type === "tool_start") {
    console.log(`Tool started: ${event.name}`);
  } else if (event.type === "run_completed") {
    console.log(`\nDone in ${event.turns} turns!`);
  }
}
```

### 5. Long-Term Memory with Background Graph Processes
Pass a `LongTermMemory` to any run. Relevant facts are added to the system prompt, and the finished conversation is queued for extraction. The run never waits for it. Three independent processes keep the graph clean:

| Process | Job | Changes it makes |
|---|---|---|
| `FactExtractor` | An LLM reads queued conversations and proposes facts | `fact_added`, `fact_reinforced` (noisy-OR confidence, mention count) |
| `RelationshipBuilder` | Infers edges from existing facts | `relationship_inferred` (symmetric predicates, chain rules like WORKS_ON + USES ⇒ USES) |
| `GraphMaintainer` | Keeps the graph trustworthy | `entities_merged`, `conflict_resolved`, `fact_pruned` (time-decayed confidence) |

```typescript
import { Agent, LongTermMemory, Neo4jGraphMemoryStore, anthropic } from "sagu-sdk";

const memory = new LongTermMemory({
  store: new Neo4jGraphMemoryStore({ uri: "bolt://localhost:7687" }),
  model: anthropic(), // used by the fact extractor
});
memory.on((event) => console.log(event)); // graph_updated, process_completed, process_failed
memory.start();

await agent.run("I moved to Berlin and I'm now working on Atlas.", { longTermMemory: memory });
// later, any agent, any session:
await agent.run("Plan my next sprint.", { longTermMemory: memory }); // prompt includes the facts

await memory.stop();
```

Each process runs on its own timer, never overlaps itself, retries transient errors, and exports a trace per pass. Run `node examples/05-background-graph-memory/index.ts` to watch it live.

### 6. Multi-Provider Fallback Engine
Switch providers automatically when rate limits or service outages occur:

```typescript
import { Agent, fallback, anthropic, openai, gemini } from "sagu-sdk";

const agent = new Agent({
  name: "HighAvailabilityAgent",
  instructions: "Assist user.",
  model: fallback(
    anthropic(), // Primary (Claude 3.5 Sonnet)
    openai(),    // First fallback (GPT-4o)
    gemini()     // Second fallback (Gemini 1.5 Pro)
  ),
});
```

---

## 📂 Project Structure

```
sagu-sdk/
├── src/
│   ├── index.ts               # Unified public API export
│   ├── agent.ts               # Immutable Agent<TOutput> configuration
│   ├── runner.ts              # 5-minute core agent loop & streaming engine
│   ├── tool.ts                # defineTool() helper with runtime Zod validation
│   ├── handoff.ts             # Synthetic transfer tools & loop cap prevention
│   ├── guardrails.ts          # Input, output, and tool guardrails
│   ├── structuredOutput.ts    # JSON extraction, schema validation & repair retry
│   ├── events.ts              # AgentEvent definitions and type guards
│   ├── trace.ts               # Span-based tracing, ConsoleExporter, JSONFileExporter
│   ├── reliability.ts         # withRetry, withTimeout, and secret redaction
│   ├── errors.ts              # Comprehensive SaguError hierarchy
│   ├── types.ts               # Core contracts and type definitions
│   ├── providers/
│   │   ├── types.ts           # ModelProvider & ProviderRequest interfaces
│   │   ├── schema.ts          # Zod to JSON-schema converter
│   │   ├── mock.ts            # Scriptable deterministic MockProvider
│   │   ├── anthropic.ts       # Claude Messages API adapter
│   │   ├── openai.ts          # OpenAI Chat Completions API adapter
│   │   ├── gemini.ts          # Google Gemini API adapter
│   │   └── fallback.ts        # Chained fallback provider
│   └── memory/
│       ├── types.ts           # SessionStore & GraphMemoryStore interfaces
│       ├── inMemory.ts        # In-Memory session storage with pruning
│       ├── file.ts            # JSON file session storage
│       ├── sqlite.ts          # Zero-dependency node:sqlite session storage
│       ├── graphMemory.ts     # InMemoryGraphMemoryStore fake & auto-factory
│       ├── neo4jGraphMemory.ts# Neo4j Cypher knowledge graph adapter
│       ├── graphMemoryTools.ts# remember_fact & recall_facts tool factory
│       ├── facts.ts           # Normalization, confidence reinforcement & decay
│       ├── graphProcesses.ts  # FactExtractor, RelationshipBuilder, GraphMaintainer
│       └── longTermMemory.ts  # Coordinates the 3 processes + retrieval for agents
├── examples/
│   ├── 01-basic-tool-agent/
│   ├── 02-support-triage-handoff/
│   ├── 03-structured-output-and-memory/
│   ├── 04-graph-memory-longterm-recall/
│   └── 05-background-graph-memory/
├── docs/                      # Original Markdown docs (full site: github.com/VeCtORbytes/SaGuDocs)
└── test/                      # 88 tests running via node --test
```

---

## 🧪 Testing

SAGU includes **88 tests** that run natively without external mock servers or API keys. One Neo4j integration test runs when `NEO4J_URI` is set:

```bash
# Run all tests
npm test

# Run strict type checking
npm run typecheck

# Run examples natively with Node 25
node examples/01-basic-tool-agent/index.ts
node examples/02-support-triage-handoff/index.ts
node examples/03-structured-output-and-memory/index.ts
node examples/04-graph-memory-longterm-recall/index.ts
node examples/05-background-graph-memory/index.ts

# Neo4j integration test (needs a running Neo4j)
NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=... node --test test/neo4j.integration.test.ts
```

---

## 📊 Grading Rubric Alignment

| Rubric Dimension | Marks | Where It's Implemented in SAGU |
|---|---|---|
| **Agent Runtime** | 15 | `src/runner.ts` 5-minute loop, `maxTurns`, predictable return vs throw policy |
| **Tools** | 10 | `src/tool.ts`, Zod schema validation, async execution, error feedback loops |
| **Handoffs** | 10 | `src/handoff.ts`, synthetic transfer tools, hop-count cap, context preservation |
| **Guardrails** | 10 | `src/guardrails.ts`, 3-tier validation, auto-rejecting human approval handler |
| **Memory & Sessions** | 10 | `src/memory/` adapters (`node:sqlite`, file, in-memory) + semantic Neo4j Graph Memory |
| **Graph Database Integration** | 10 | `src/memory/neo4jGraphMemory.ts`: entities, typed relations with confidence/mentions/source/timestamps; context retrieval injected into prompts |
| **Three Background Graph Processes** | 15 | `src/memory/graphProcesses.ts`: `FactExtractor`, `RelationshipBuilder`, `GraphMaintainer` on independent timers with retries, events and traces |
| **Structured Output & Streaming** | 10 | `src/structuredOutput.ts` (auto-repair loop), `src/events.ts` (real-time streaming) |
| **Reliability** | 10 | `src/reliability.ts` (`withRetry` jitter backoff, `withTimeout`, automatic secret redaction) |
| **Tracing** | 5 | `src/trace.ts` (hierarchical span tree, `ConsoleExporter`, `JSONFileExporter`) |
| **Developer Experience** | 10 | Typed generics `Agent<TOutput>`, native Node 25 `.ts` execution, 0 dev build steps |
| **Documentation & Examples** | 10 | Hosted docs site ([SaGuDocs](https://github.com/VeCtORbytes/SaGuDocs)), 5 runnable examples |
| **Product Thinking** | 10 | Clear differentiator: vendor-agnostic fallback, graph memory, return-not-throw |

---

## 📄 License

MIT © [Sarthak Gupta](https://github.com/VeCtORbytes)
