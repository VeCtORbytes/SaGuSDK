import {
  Agent,
  LongTermMemory,
  createAutoGraphMemoryStore,
  mock,
  type GraphEvent,
} from "../../src/index.ts";

/**
 * Example 5: Long-term memory maintained by three background processes
 *
 * Demonstrates:
 * 1. Agent runs that read long-term context and queue conversations, without waiting on extraction
 * 2. Process 1 (FactExtractor)       — an LLM turns conversations into graph facts
 * 3. Process 2 (RelationshipBuilder) — infers new edges (symmetric + chain rules)
 * 4. Process 3 (GraphMaintainer)     — merges duplicates, resolves conflicts, prunes stale facts
 * 5. A later, unrelated session receiving the cleaned-up facts in its prompt
 *
 * Uses Neo4j when NEO4J_URI is set, otherwise an in-memory graph. Scripted models: no API keys.
 */

const store = await createAutoGraphMemoryStore();

// The extractor's model. Swap for anthropic()/openai()/gemini() to extract from real conversations.
const extractorModel = mock([
  JSON.stringify({
    facts: [
      { subject: "User", predicate: "WORKS_ON", object: "Atlas", confidence: 0.95 },
      { subject: "User", predicate: "COLLEAGUE_OF", object: "Raj", confidence: 0.9 },
      { subject: "Atlas", predicate: "USES", object: "neo4j", confidence: 0.9 },
      { subject: "User", predicate: "LIVES_IN", object: "Paris", confidence: 0.9 },
      { subject: "User", predicate: "PREFERS", object: "type-script", confidence: 0.8 },
    ],
  }),
  JSON.stringify({
    facts: [
      { subject: "User", predicate: "LIVES_IN", object: "Berlin", confidence: 0.95 },
      { subject: "Atlas", predicate: "USES", object: "TypeScript", confidence: 0.9 },
      { subject: "Atlas", predicate: "USES", object: "Neo4j", confidence: 0.8 },
    ],
  }),
]);

const memory = new LongTermMemory({
  store,
  model: extractorModel,
  relationships: { intervalMs: 400 },
  maintenance: { intervalMs: 800 },
});

memory.on((event) => {
  const line = describe(event);
  if (line) console.log(line);
});
memory.start(); // three independent loops from here on

const assistantModel = mock([
  "Nice to meet you! Atlas sounds fun.",
  "Congrats on the move to Berlin!",
  "Since Atlas is TypeScript on Neo4j, I'd plan the migration around the graph schema first.",
]);
const assistant = new Agent({
  name: "Assistant",
  instructions: "You are a helpful engineering assistant.",
  model: assistantModel,
});

console.log("=== Sagu SDK: Example 05 - Background Graph Memory ===\n");

console.log("[run 1] User: I'm working on Atlas with my colleague Raj. It runs on neo4j. I live in Paris and prefer type-script.");
let started = Date.now();
await assistant.run("I'm working on Atlas with my colleague Raj. It runs on neo4j. I live in Paris and prefer type-script.", {
  longTermMemory: memory,
  sessionId: "chat-1",
});
console.log(`[run 1] returned in ${Date.now() - started}ms; extraction queued: ${memory.extractor.pending}\n`);
await waitFor((e) => e.type === "process_completed" && e.process === "fact_extractor" && e.changes > 0);

console.log("\n[run 2] User: I just moved to Berlin. Atlas also uses TypeScript.");
started = Date.now();
await assistant.run("I just moved to Berlin. Atlas also uses TypeScript.", { longTermMemory: memory, sessionId: "chat-2" });
console.log(`[run 2] returned in ${Date.now() - started}ms\n`);

// Let the background processes catch up: extraction, then inference and maintenance on their own timers.
await waitFor((e) => e.type === "process_completed" && e.process === "fact_extractor" && e.changes > 0);
await waitFor((e) => e.type === "process_completed" && e.process === "graph_maintainer" && e.changes > 0);
await waitFor((e) => e.type === "process_completed" && e.process === "relationship_builder");

console.log("\n--- Graph after background processing ---");
for (const f of (await store.listFacts()).sort((a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate))) {
  console.log(`  (${f.subject}) -[${f.predicate}]-> (${f.object})   confidence=${(f.confidence ?? 1).toFixed(2)} source=${f.source}`);
}

console.log("\n[run 3] New session, no chat history. User: Help me plan a database migration.");
for await (const event of assistant.stream("Help me plan a database migration.", { longTermMemory: memory })) {
  if (event.type === "memory_updated") console.log(`  memory_updated: ${event.operation} (${event.count})`);
  if (event.type === "run_completed") console.log(`Assistant: ${event.output}`);
}
const injected = assistantModel.lastRequest?.systemPrompt?.split("[LONG-TERM MEMORY]")[1] ?? "";
console.log("\nContext injected into run 3's system prompt:" + injected);

await memory.stop();
await store.close();

function waitFor(match: (e: GraphEvent) => boolean): Promise<GraphEvent> {
  return new Promise((resolve) => {
    const off = memory.on((e) => {
      if (match(e)) {
        off();
        resolve(e);
      }
    });
  });
}

function describe(e: GraphEvent): string {
  const tag = `  ⟳ [${e.process}]`;
  if (e.type === "process_failed") return `${tag} failed (attempt ${e.attempt}, retry: ${e.willRetry})`;
  if (e.type === "process_completed") return e.changes ? `${tag} pass done: ${e.changes} change(s) in ${e.durationMs}ms` : "";
  switch (e.operation) {
    case "fact_added":
    case "fact_reinforced":
      return `${tag} ${e.operation}: ${e.fact.subject} ${e.fact.predicate} ${e.fact.object}`;
    case "relationship_inferred":
    case "relationship_updated":
      return `${tag} ${e.operation} (${e.rule}): ${e.fact.subject} ${e.fact.predicate} ${e.fact.object} @ ${(e.fact.confidence ?? 1).toFixed(2)}`;
    case "entities_merged":
      return `${tag} entities_merged: "${e.from}" → "${e.into}"`;
    case "conflict_resolved":
      return `${tag} conflict_resolved: kept ${e.kept.predicate} ${e.kept.object}, removed ${e.removed.object}`;
    case "fact_pruned":
      return `${tag} fact_pruned (${e.reason}): ${e.fact.subject} ${e.fact.predicate} ${e.fact.object}`;
  }
}
