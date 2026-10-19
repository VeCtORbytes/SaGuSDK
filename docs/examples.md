# Examples Walkthrough

SAGU includes 4 runnable examples in the `examples/` directory that you can run natively with Node 25.

---

## 1. Basic Tool Agent (`examples/01-basic-tool-agent/index.ts`)

Demonstrates:
- Creating custom tools with `defineTool()` and Zod validation
- Deterministic mock provider execution without network dependencies
- Terminal trace inspection using `ConsoleExporter`

**Run:**
```bash
node examples/01-basic-tool-agent/index.ts
```

---

## 2. Support Triage Handoff (`examples/02-support-triage-handoff/index.ts`)

Demonstrates:
- Multi-agent handoffs (`TriageAgent` -> `BillingSpecialist` / `TechSpecialist`)
- Automatic generation of synthetic transfer tools (`transfer_to_<agent>`)
- Streaming execution events (`handoff`, `tool_start`, `tool_end`, `run_completed`)

**Run:**
```bash
node examples/02-support-triage-handoff/index.ts
```

---

## 3. Structured Output & SQLite Memory (`examples/03-structured-output-and-memory/index.ts`)

Demonstrates:
- Strict output schema extraction with `Agent<LeadProfile>`
- Automatic schema self-repair retry loop when model outputs invalid JSON
- Zero-dependency conversation persistence using Node 25's built-in `node:sqlite` (`SqliteSession`) across multiple runs

**Run:**
```bash
node examples/03-structured-output-and-memory/index.ts
```

---

## 4. Graph Long-Term Memory Recall (`examples/04-graph-memory-longterm-recall/index.ts`)

Demonstrates:
- Knowledge graph memory storing semantic relationships `(subject -> predicate -> object)`
- Autonomous fact recording via `remember_fact` tool
- Querying facts across completely disjoint sessions using `recall_facts` tool

**Run:**
```bash
node examples/04-graph-memory-longterm-recall/index.ts
```
