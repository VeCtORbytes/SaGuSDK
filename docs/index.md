# SAGU SDK Documentation

**SAGU** is an open-source, vendor-agnostic TypeScript SDK for building tool-using, multi-agent LLM applications — written from scratch with zero framework dependencies (no LangChain, no CrewAI).

> *A small enough agent loop to read in five minutes, that doesn't lock you to one model vendor.*

---

## Key Features

1. **Readable Core Loop:** The entire runtime loop is implemented cleanly in `src/runner.ts`. It takes 5 minutes to read and understand every state transition.
2. **Predictable Control Flow:** `agent.run()` **never throws on expected execution outcomes** (guardrail trips, max turns, approval rejections, handoff loops, schema repair exhaustion). It returns `{ success: true, output, ... }` or `{ success: false, error, ... }`, eliminating messy try/catch logic.
3. **Multi-Agent Handoffs:** Agents seamlessly delegate tasks to specialists via synthetic transfer tools with built-in loop prevention (`maxHandoffs`).
4. **Three-Tier Guardrails:** Full safety lifecycle support with input guardrails, output guardrails, tool parameter guardrails, and human-in-the-loop tool approval.
5. **Dual Memory Architecture:**
   - **SessionStore:** Raw conversation history (In-Memory, File, and zero-dependency `node:sqlite`).
   - **GraphMemoryStore:** Cross-session semantic knowledge graph (facts and relationships) backed by Neo4j or in-memory fake.
6. **Structured Output with Auto-Repair:** Type-safe outputs enforced with Zod schemas that automatically feed validation errors back to the model for self-repair retries.
7. **Unified Streaming & Events:** `agent.stream()` yields fine-grained events (`text_delta`, `tool_start`, `tool_end`, `handoff`, `guardrail_triggered`, `run_completed`, `run_failed`). `agent.run()` simply drains this stream — one loop, not two.
8. **Built-in Tracing & Secret Redaction:** Hierarchical span tracking (`run`, `model_call`, `tool_execution`, `guardrail`) with automatic redaction of API keys and secrets.
9. **Multi-Provider & Fallback Engine:** First-class native adapters for Claude (Anthropic), OpenAI, and Google Gemini, plus deterministic `mock()` testing and automated multi-provider fallback.
10. **Native Node TypeScript Execution:** Runs `.ts` files directly in Node 25 without `tsx`, `ts-node`, or build steps.

---

## Architectural Separation

SAGU strictly enforces separation of concerns across three layers:

| Layer | Responsibility | State Lifecycle |
|---|---|---|
| **AgentConfig** | Static agent definition: instructions, tools, model, guardrails, handoffs, schema | Immutable after construction |
| **RunState** | Single `.run()` execution: active agent, current messages, turn count, token usage, trace spans | Created fresh per run, discarded after |
| **SessionState** | Conversation history persisted across separate runs | Pluggable `SessionStore` interface |

---

## Navigation Guide

- [Quickstart Guide](quickstart.md) — Get up and running in 3 minutes.
- [Tools & Function Calling](tools.md) — Defining tools, Zod validation, timeouts, and human approval.
- [Multi-Agent Handoffs](handoffs.md) — Swapping active agents and preventing circular ping-pong.
- [Guardrails](guardrails.md) — Input sanitization, leak prevention, and tool parameter guards.
- [Memory & Sessions](memory-and-sessions.md) — SQLite conversation history and Neo4j graph memory.
- [Structured Output](structured-output.md) — Zod schema validation and automatic self-repair retry loop.
- [Streaming & Events](streaming-and-events.md) — Real-time token streaming and lifecycle events.
- [Tracing & Observability](tracing.md) — Span trees, ConsoleExporter, JSONFileExporter, and secret redaction.
- [Error Handling](error-handling.md) — Predictable error hierarchy and return-vs-throw policy.
- [API Reference](api-reference.md) — Comprehensive reference of all exported classes and functions.
- [Examples](examples.md) — Complete walkthrough of runnable examples.
