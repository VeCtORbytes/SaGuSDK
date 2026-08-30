# SAGU SDK — Project Plan

Reference doc for the "Build Your Own Agent SDK" assignment (GenAI with JS 2026).
Nothing is built yet — this is the plan to build from, step by step.

> ⚠️ Heads up: the brief's own timeline (due Aug 3, eval ends Aug 5, 2026) is
> already in the past relative to today. Confirm with organizers whether this
> is still a live submission before treating dates below as real deadlines.

---

## 1. What we're building

An open-source TypeScript SDK for building tool-using, multi-agent LLM
applications — written from scratch (no LangChain/CrewAI/etc. underneath).
Developers get: `Agent` + tools + a real agent loop, multi-agent handoffs,
guardrails, memory/sessions, structured output, streaming events, tracing,
retries, and a provider abstraction (Claude / OpenAI / Gemini + a mock for
testing).

**Name:** **SAGU** — your open-source AI Agent SDK (from SArthak GUpta).
Memorable, developer-friendly, punchy. npm package: `sagu-sdk`.

**Pitch, one line:** *a small enough agent loop to read in five minutes,
that doesn't lock you to one model vendor.*

- **Who it's for:** JS/TS devs building tool-using LLM features who don't
  want a heavyweight framework or a single-vendor lock-in.
- **Problem:** existing agent frameworks hide the loop (hard to debug) or
  tie you to one provider's tool-calling format.
- **Why it should exist:** readable core loop, real provider fallback, real
  session adapters — not config flags that don't do anything.
- **Differentiation:** `run()` never throws on *expected* failures (it
  returns `{success:false, error}`); native Node TS execution, no build
  step in dev; SQLite session adapter with zero dependencies; graph-based
  long-term memory (facts/relationships, not just flat chat history) behind
  the same pluggable-adapter pattern.

---

## 2. Decisions locked in

| Decision | Choice |
|---|---|
| Language | TypeScript |
| Providers wired for real | Claude (Anthropic), OpenAI, Gemini — all three |
| Default provider in tests/examples | `mock()` — no network, no API key, so `npm test` works for anyone |
| Validation library | zod |
| Test runner | `node --test` + `node:assert` (stdlib, no Jest/Vitest) |
| TS execution in dev | native — Node 25 runs `.ts` directly, confirmed working, no `tsx`/`ts-node` needed |
| SQLite adapter | `node:sqlite` (stdlib, confirmed working, zero dependency) |
| Graph long-term memory | `neo4j-driver`, but **optional and additive** — an in-memory fake implements the same interface and is the default in tests/examples; no Neo4j instance exists yet, so nothing in the base SDK depends on one being up |
| Docs hosting | GitHub Pages serving `/docs`, plain markdown, no Docusaurus |
| API keys | none set in this environment — real providers must fail with a clear error when a key is missing, everything else must run without one |

---

## 3. Architecture — the three layers

Kept explicitly separate (this separation is graded directly):

| Layer | What it is | Where |
|---|---|---|
| **AgentConfig** | static: name, instructions, model, tools, schema, guardrails, handoffs | `Agent` class — immutable after construction |
| **RunState** | one `.run()` call: message history *for this run*, turn count, current agent (after handoffs), trace | built fresh each run, discarded after |
| **SessionState** | history persisted *across* runs | `SessionStore` interface, fully pluggable, agent never touches storage directly |

## 4. The core loop (plain-language version)

```
1. Load prior history from the session (if any) + the new user input.
2. Run input guardrails — bail out cleanly if one blocks.
3. Loop, up to maxTurns:
   a. Send instructions + history + tool specs to the model.
   b. If the model returns tool calls:
      - a "handoff" call switches the active agent (loop-hop counter caps it)
      - a real tool call gets zod-validated, approval-checked, executed
        with a timeout, and its result (or error) is fed back as a message
      - go to (a)
   c. If the model returns plain text: validate against outputSchema (if
      set, with repair retries), run output guardrails, save to session,
      return {success:true, output, ...}.
4. Hit maxTurns without a final answer → return {success:false, error}.
```

`run()` only *throws* for programmer mistakes (bad config). Every expected
failure mode — guardrail block, max-turns, handoff loop, schema exhausted —
comes back as `{success:false, error}` so callers don't need try/catch for
normal control flow.

## 5. Repo layout (target — not yet created)

```
sagu-sdk/
  package.json  tsconfig.json  README.md  LICENSE  PLAN.md
  src/
    index.ts  types.ts  errors.ts  tool.ts  agent.ts  runner.ts
    guardrails.ts  structuredOutput.ts  handoff.ts  reliability.ts
    trace.ts  events.ts
    providers/  types.ts  schema.ts  anthropic.ts  openai.ts  gemini.ts  mock.ts  fallback.ts
    memory/     types.ts  inMemory.ts  file.ts  sqlite.ts
                graphMemory.ts (interface + in-memory fake)
                neo4jGraphMemory.ts (real adapter, neo4j-driver)
                graphMemoryTools.ts (remember/recall tool factory)
  test/          one file per module, node:test
  examples/
    01-basic-tool-agent/
    02-support-triage-handoff/
    03-structured-output-and-memory/
    04-graph-memory-longterm-recall/
  docs/           installation, quickstart, tools, handoffs, guardrails,
                  memory-and-sessions, structured-output, streaming-and-events,
                  tracing, error-handling, api-reference, examples
```

## 6. Module-by-module design notes

- **`tool.ts`** — `defineTool({name, description, input: zodSchema, execute, requiresApproval?, timeoutMs?})`. One identity function, no builder class.
- **`providers/`** — one `ModelProvider` interface (`generate(req) → {content, toolCalls, stopReason, usage}`); adapters for Anthropic/OpenAI/Gemini translate their vendor tool-call format to/from this shape; `mock(script)` is deterministic and scriptable per test; `fallback(providerA, providerB, ...)` tries in order on `ProviderError`.
- **`handoff.ts`** — each handoff target becomes a synthetic `transfer_to_<name>` tool; runner intercepts it before real tool execution and swaps the active agent. Loop prevention = hop counter (`maxHandoffs`, default 5), not full cycle detection — simplest thing that actually prevents infinite loops.
- **`guardrails.ts`** — `inputGuardrail`/`outputGuardrail`/`toolGuardrail`, all shaped `(value) => {pass, reason?, modified?}`. `requiresApproval` tools need an `onApprovalRequired` callback; no callback = auto-reject, never auto-approve.
- **`structuredOutput.ts`** — model asked for JSON matching the zod-derived schema; `safeParse`; on failure, issues fed back to the model, retried up to `maxRepairAttempts` (default 2); exhausted → `StructuredOutputError`.
- **`memory/`** — `SessionStore` interface (`getHistory`, `appendMessages`, `clear`); `InMemorySession`, `FileSession`, `SqliteSession` (via `node:sqlite`) ship as real adapters. This is raw *conversation* history — sequential, per session id.
- **Graph memory (separate from `SessionStore`)** — long-term, cross-session *semantic* memory: facts and relationships, not message text. One interface:
  ```ts
  interface GraphMemoryStore {
    remember(entry: { subject: string; predicate: string; object: string }): Promise<void>;
    recall(query: { about: string; limit?: number }): Promise<Array<{ subject: string; predicate: string; object: string }>>;
    close(): Promise<void>;
  }
  ```
  Exposed to an agent as two ordinary tools — `createGraphMemoryTools(store)` returns `[rememberTool, recallTool]` — so it plugs into the existing tool system, no new core-loop concept. `InMemoryGraphMemoryStore` (a plain array, same interface) is the default everywhere. `Neo4jGraphMemoryStore` implements the same interface with real Cypher (`MERGE` nodes for subject/object, `MERGE` a relationship typed by `predicate`; `recall` does a substring `MATCH ... WHERE toLower(a.name) CONTAINS ...`). Selection is env-driven and automatic: `NEO4J_URI` set → real store, otherwise the in-memory fake — so the same example code runs with or without a database.
  `ponytail: no LLM-based fact extraction pipeline — the agent calls remember() explicitly via the tool when it decides something's worth keeping. Add an automatic extraction pass later only if manual remember-calls prove too sparse.`
- **`events.ts`** — `agent.stream(input)` is an async generator yielding `text_delta` / `tool_start` / `tool_end` / `handoff` / `guardrail_triggered` / `run_completed` / `run_failed`; `agent.run()` just drains the same generator and returns its final value — one loop, not two.
- **`trace.ts`** — `Trace {runId, spans[], usage}` populated inline by the loop; `ConsoleExporter` + `JSONFileExporter`.
- **`reliability.ts`** — `withRetry` (exponential backoff, only on transient provider errors), `withTimeout` (`Promise.race` + `AbortController`), secrets read only from `process.env`, redacted in trace output.

## 7. Build order (checkpoint after each step, run it before moving on)

1. `types.ts`, `errors.ts`, `tool.ts` — nothing else compiles without these.
2. `providers/types.ts` + `providers/mock.ts` — test the loop with zero network.
3. Minimal `runner.ts` (tool calls + final answer, maxTurns) + `agent.ts`. ✅ checkpoint: one working tool-call round trip, one test proving it.
4. Add handoffs. ✅ checkpoint: triage → billing handoff test passes, loop-cap test passes.
5. Add guardrails (input/output/tool + approval). ✅ checkpoint: a blocked input returns `success:false` cleanly.
6. Add structured output. ✅ checkpoint: schema violation triggers a repair retry, then a typed result.
7. Add memory adapters (`InMemory`, `File`, `Sqlite`). ✅ checkpoint: two `.run()` calls share context via a session id.
7b. Add graph memory: `GraphMemoryStore` interface + `InMemoryGraphMemoryStore` fake + `remember`/`recall` tools. ✅ checkpoint: agent remembers a fact in one `.run()`, recalls it in a later one, no Neo4j required. Add `Neo4jGraphMemoryStore` once you actually have an instance to point it at (`docker run -p 7687:7687 neo4j` when ready) — same interface, swap-in only.
8. Add `trace.ts` + `events.ts`/streaming.
9. Real providers: Anthropic first, then OpenAI, then Gemini; then `fallback.ts`.
10. Tests alongside every step above (already implied — not batched at the end).
11. Examples (3), then docs (docs get easier once the API is frozen by working examples).
12. README + pitch section, then the demo video last, once the demo path is stable.

## 8. Non-code deliverables (need your input/action, not mine)

- **Public GitHub repo** — I can prepare the local repo; pushing to a public GitHub repo needs your go-ahead (and your GitHub auth) at that point.
- **Hosted docs** — GitHub Pages from `/docs`, flip on in repo settings once pushed.
- **npm publish** — needs your npm login; I can prep `package.json` but won't publish without you asking.
- **Demo video** — you on camera; script outline can be drafted, recording/posting is yours.
- **Public social post** — outward-facing, needs your explicit go-ahead per post.

## 9. Grading rubric → where it's covered

| Rubric item | Marks | Covered by |
|---|---|---|
| Agent Runtime | 15 | `runner.ts` loop, maxTurns, `success:false` results |
| Tools | 10 | `tool.ts`, zod validation, async execute, error → tool-result |
| Handoffs | 10 | `handoff.ts`, hop-count cap, trace events |
| Guardrails | 10 | `guardrails.ts`, approval callback |
| Memory & Sessions | 10 | `memory/` adapters + `SessionStore` interface, plus `GraphMemoryStore` (Neo4j-backed) for semantic long-term memory |
| Structured Output & Streaming | 10 | `structuredOutput.ts`, `events.ts` |
| Reliability | 10 | `reliability.ts`, maxTurns/maxHandoffs, secret redaction |
| Tracing | 5 | `trace.ts` |
| Developer Experience | 10 | typed generics on `Agent<TOutput>`, one-function tool API, native TS execution |
| Documentation & Examples | 10 | `docs/`, 3 examples |
| Product Thinking | 10 | §1 pitch above, graph memory as a concrete differentiator vs. flat-history-only competitors |
| Demo & Pitch | 10 | video (yours to record) |

---

## Next step

Say **go** on step 1 (or any specific step) and I'll start writing that piece
only — small, checkpointed, one thing at a time, so it's easy to follow.
