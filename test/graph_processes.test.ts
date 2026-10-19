import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Agent,
  FactExtractor,
  GraphMaintainer,
  InMemoryGraphMemoryStore,
  LongTermMemory,
  RelationshipBuilder,
  mock,
  type GraphEvent,
  type GraphMemoryStore,
  type Message,
} from "../src/index.ts";

const DAY = 24 * 60 * 60 * 1000;

const conversation = (text: string): Message[] => [
  { role: "user", content: text },
  { role: "assistant", content: "Noted." },
];

const extraction = (facts: Array<[string, string, string, number]>) =>
  JSON.stringify({ facts: facts.map(([subject, predicate, object, confidence]) => ({ subject, predicate, object, confidence })) });

function collect() {
  const events: GraphEvent[] = [];
  return { events, onEvent: (e: GraphEvent) => events.push(e) };
}

/* ---------------------------------- store --------------------------------- */

test("InMemoryGraphMemoryStore - tracks confidence, mentions and timestamps", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "User", predicate: "USES", object: "Neo4j", confidence: 0.6, createdAt: 1000, updatedAt: 1000 });
  await store.remember({ subject: "user", predicate: "uses", object: "neo4j", confidence: 0.9 });

  const [fact] = await store.listFacts();
  assert.equal((await store.listFacts()).length, 1, "case-insensitive identity");
  assert.equal(fact?.mentions, 2);
  assert.equal(fact?.confidence, 0.9);
  assert.equal(fact?.createdAt, 1000, "createdAt preserved");
  assert.ok((fact?.updatedAt ?? 0) > 1000, "updatedAt refreshed");

  await store.forget({ subject: "USER", predicate: "USES", object: "NEO4J" });
  assert.equal((await store.listFacts()).length, 0);
});

test("InMemoryGraphMemoryStore - mergeEntities rewrites facts, combines duplicates, drops self-loops", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "User", predicate: "USES", object: "typescript", confidence: 0.5 });
  await store.remember({ subject: "User", predicate: "USES", object: "Type Script", confidence: 0.8 });
  await store.remember({ subject: "Type Script", predicate: "SAME_AS", object: "typescript" });

  await store.mergeEntities("Type Script", "typescript");

  const facts = await store.listFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.object, "typescript");
  assert.equal(facts[0]?.confidence, 0.8, "keeps the higher confidence");
  assert.equal(facts[0]?.mentions, 2, "sums mentions");
});

/* ------------------------------ process 1 --------------------------------- */

test("FactExtractor - extracts, normalizes and filters facts from a queued conversation", async () => {
  const store = new InMemoryGraphMemoryStore();
  const { events, onEvent } = collect();
  const extractor = new FactExtractor({
    store,
    onEvent,
    model: mock([
      extraction([
        ["User", "works on", "Atlas", 0.95],
        [" Atlas ", "uses", "Neo4j", 0.9],
        ["User", "IS", "user", 0.9], // self-loop
        ["User", "MIGHT_LIKE", "Rust", 0.2], // below minConfidence
      ]),
    ]),
  });

  extractor.enqueue({ messages: conversation("I work on Atlas, which runs on Neo4j."), sessionId: "s1" });
  assert.equal(extractor.pending, 1);
  const changes = await extractor.runOnce();

  assert.equal(changes, 2);
  assert.equal(extractor.pending, 0);
  const facts = await store.listFacts();
  assert.deepEqual(
    facts.map((f) => `${f.subject} ${f.predicate} ${f.object}`).sort(),
    ["Atlas USES Neo4j", "User WORKS_ON Atlas"]
  );
  assert.equal(facts[0]?.source, "session:s1");
  assert.equal(events.filter((e) => e.type === "graph_updated" && e.operation === "fact_added").length, 2);
  assert.ok(events.some((e) => e.type === "process_completed" && e.changes === 2));
});

test("FactExtractor - repeated facts are reinforced, not duplicated", async () => {
  const store = new InMemoryGraphMemoryStore();
  const { events, onEvent } = collect();
  const extractor = new FactExtractor({
    store,
    onEvent,
    model: mock([extraction([["User", "USES", "Neo4j", 0.6]]), extraction([["User", "USES", "Neo4j", 0.5]])]),
  });

  extractor.enqueue({ messages: conversation("We use Neo4j.") });
  await extractor.runOnce();
  extractor.enqueue({ messages: conversation("Neo4j again.") });
  await extractor.runOnce();

  const facts = await store.listFacts();
  assert.equal(facts.length, 1);
  assert.ok(Math.abs((facts[0]?.confidence ?? 0) - 0.8) < 1e-9, "noisy-OR: 1-(0.4*0.5)=0.8");
  assert.equal(facts[0]?.mentions, 2);
  assert.ok(events.some((e) => e.type === "graph_updated" && e.operation === "fact_reinforced"));
});

test("FactExtractor - failed conversations are retried, then dropped", async () => {
  const store = new InMemoryGraphMemoryStore();
  const { events, onEvent } = collect();
  const extractor = new FactExtractor({
    store,
    onEvent,
    maxAttempts: 2,
    model: mock([{ error: "bad request", statusCode: 400 }, { error: "bad request", statusCode: 400 }]),
  });

  extractor.enqueue({ messages: conversation("hello") });
  await extractor.runOnce();
  assert.equal(extractor.pending, 1, "requeued after first failure");
  await extractor.runOnce();
  assert.equal(extractor.pending, 0, "dropped after maxAttempts");

  const failures = events.filter((e) => e.type === "process_failed");
  assert.deepEqual(failures.map((e) => e.type === "process_failed" && e.willRetry), [true, false]);
});

/* ------------------------------ process 2 --------------------------------- */

test("RelationshipBuilder - infers chain and symmetric relationships without duplicates", async () => {
  const store = new InMemoryGraphMemoryStore();
  const { events, onEvent } = collect();
  await store.remember({ subject: "User", predicate: "WORKS_ON", object: "Atlas", confidence: 0.9 });
  await store.remember({ subject: "Atlas", predicate: "USES", object: "Neo4j", confidence: 0.8 });
  await store.remember({ subject: "Alice", predicate: "KNOWS", object: "Bob", confidence: 1 });
  await store.remember({ subject: "Wheel", predicate: "PART_OF", object: "Car" });
  await store.remember({ subject: "Car", predicate: "PART_OF", object: "Wheel" }); // would infer self-loops

  const builder = new RelationshipBuilder({ store, onEvent });
  assert.equal(await builder.runOnce(), 2);

  const facts = await store.listFacts();
  const inferred = facts.find((f) => f.subject === "User" && f.predicate === "USES" && f.object === "Neo4j");
  assert.ok(inferred);
  assert.ok(Math.abs((inferred.confidence ?? 0) - 0.72) < 1e-9);
  assert.equal(inferred.source, "inferred:works_on_uses");
  assert.ok(facts.some((f) => f.subject === "Bob" && f.predicate === "KNOWS" && f.object === "Alice"));
  assert.ok(!facts.some((f) => f.subject === f.object), "no self-loops");

  assert.equal(await builder.runOnce(), 0, "second pass creates nothing new");
  assert.equal(events.filter((e) => e.type === "graph_updated" && e.operation === "relationship_inferred").length, 2);
});

test("RelationshipBuilder - never overwrites a stated fact", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "User", predicate: "WORKS_ON", object: "Atlas", confidence: 0.9 });
  await store.remember({ subject: "Atlas", predicate: "USES", object: "Neo4j", confidence: 0.9 });
  await store.remember({ subject: "User", predicate: "USES", object: "Neo4j", confidence: 1, source: "session:x" });

  assert.equal(await new RelationshipBuilder({ store }).runOnce(), 0);
  const stated = (await store.listFacts()).find((f) => f.predicate === "USES" && f.subject === "User");
  assert.equal(stated?.source, "session:x");
  assert.equal(stated?.confidence, 1);
});

/* ------------------------------ process 3 --------------------------------- */

test("GraphMaintainer - merges duplicate entities into the canonical name", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "User", predicate: "USES", object: "TypeScript" });
  await store.remember({ subject: "Atlas", predicate: "WRITTEN_IN", object: "TypeScript" });
  await store.remember({ subject: "User", predicate: "LIKES", object: "type script" });
  await store.remember({ subject: "User", predicate: "USES", object: "C#" });
  await store.remember({ subject: "User", predicate: "KNOWS_LANG", object: "C" });

  const { events, onEvent } = collect();
  await new GraphMaintainer({ store, onEvent }).runOnce();

  const objects = (await store.listFacts()).map((f) => f.object).sort();
  assert.deepEqual(objects, ["C", "C#", "TypeScript", "TypeScript", "TypeScript"]);
  assert.ok(events.some((e) => e.type === "graph_updated" && e.operation === "entities_merged" && e.from === "type script" && e.into === "TypeScript"));
});

test("GraphMaintainer - resolves conflicting single-valued facts (newest wins)", async () => {
  const store = new InMemoryGraphMemoryStore();
  const now = Date.now();
  await store.remember({ subject: "User", predicate: "LIVES_IN", object: "Paris", updatedAt: now - 10 * DAY });
  await store.remember({ subject: "User", predicate: "LIVES_IN", object: "Berlin", updatedAt: now - DAY });
  await store.remember({ subject: "User", predicate: "USES", object: "Vim" });
  await store.remember({ subject: "User", predicate: "USES", object: "Emacs" }); // multi-valued: both stay

  const { events, onEvent } = collect();
  await new GraphMaintainer({ store, onEvent }).runOnce();

  const facts = await store.listFacts();
  assert.deepEqual(facts.filter((f) => f.predicate === "LIVES_IN").map((f) => f.object), ["Berlin"]);
  assert.equal(facts.filter((f) => f.predicate === "USES").length, 2);
  const resolved = events.find((e) => e.type === "graph_updated" && e.operation === "conflict_resolved");
  assert.ok(resolved && resolved.type === "graph_updated" && resolved.operation === "conflict_resolved" && resolved.removed.object === "Paris");
});

test("GraphMaintainer - prunes stale and low-confidence facts", async () => {
  const store = new InMemoryGraphMemoryStore();
  const now = Date.now();
  await store.remember({ subject: "User", predicate: "USES", object: "jQuery", confidence: 1, updatedAt: now - 90 * DAY });
  await store.remember({ subject: "User", predicate: "MAYBE_LIKES", object: "Golf", confidence: 0.1 });
  await store.remember({ subject: "User", predicate: "USES", object: "Neo4j", confidence: 0.9 });

  const { events, onEvent } = collect();
  await new GraphMaintainer({ store, onEvent, halfLifeMs: 30 * DAY, pruneBelow: 0.2 }).runOnce();

  assert.deepEqual((await store.listFacts()).map((f) => f.object), ["Neo4j"]);
  const reasons = events.flatMap((e) => (e.type === "graph_updated" && e.operation === "fact_pruned" ? [`${e.fact.object}:${e.reason}`] : []));
  assert.deepEqual(reasons.sort(), ["Golf:low_confidence", "jQuery:stale"]);
});

/* -------------------------- independence & retries ------------------------ */

test("GraphProcess - runs in the background on its own timer and stops cleanly", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "Alice", predicate: "KNOWS", object: "Bob" });
  const completed = new Promise<GraphEvent>((resolve) => {
    const builder = new RelationshipBuilder({
      store,
      intervalMs: 10,
      onEvent: (e) => {
        if (e.type === "process_completed") {
          void builder.stop().then(() => resolve(e));
        }
      },
    });
    builder.start();
    assert.equal(builder.isRunning, true);
  });

  const event = await completed;
  assert.equal(event.type === "process_completed" && event.process, "relationship_builder");
  assert.equal((await store.listFacts()).length, 2);
});

test("GraphProcess - retries transient store errors", async () => {
  const inner = new InMemoryGraphMemoryStore();
  let calls = 0;
  const flaky: GraphMemoryStore = {
    remember: (e) => inner.remember(e),
    recall: (q) => inner.recall(q),
    forget: (k) => inner.forget(k),
    mergeEntities: (a, b) => inner.mergeEntities(a, b),
    close: () => inner.close(),
    listFacts: async () => {
      if (calls++ === 0) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      return inner.listFacts();
    },
  };

  const { events, onEvent } = collect();
  await new GraphMaintainer({ store: flaky, onEvent }).runOnce();
  assert.deepEqual(
    events.map((e) => e.type),
    ["process_failed", "process_completed"]
  );
});

/* ---------------------------- runner integration -------------------------- */

test("LongTermMemory - injects context into the prompt and queues the conversation without blocking", async () => {
  const store = new InMemoryGraphMemoryStore();
  await store.remember({ subject: "User", predicate: "PREFERS_LANGUAGE", object: "TypeScript", confidence: 0.9 });
  await store.remember({ subject: "Paris", predicate: "CAPITAL_OF", object: "France" }); // unrelated

  const memory = new LongTermMemory({
    store,
    model: mock([extraction([["User", "WORKS_ON", "Atlas", 0.9]])]),
  });

  const model = mock(["Use TypeScript."]);
  const agent = new Agent({ name: "Advisor", instructions: "Help the user.", model });

  const memoryEvents: string[] = [];
  for await (const event of agent.stream("Which language should I pick for Atlas?", { longTermMemory: memory })) {
    if (event.type === "memory_updated") memoryEvents.push(`${event.operation}:${event.count}`);
    if (event.type === "run_completed") {
      assert.ok(event.trace?.spans.some((s) => s.name === "memory_read"));
      assert.ok(event.trace?.spans.some((s) => s.name === "memory_write"));
    }
  }

  const prompt = model.lastRequest?.systemPrompt ?? "";
  assert.match(prompt, /\[LONG-TERM MEMORY\]/);
  assert.match(prompt, /User PREFERS_LANGUAGE TypeScript/);
  assert.doesNotMatch(prompt, /Paris/);
  assert.deepEqual(memoryEvents, ["context_retrieved:1", "conversation_queued:2"]);
  assert.equal(memory.extractor.pending, 1, "extraction is queued, not done inside the run");

  await memory.flush();
  assert.ok((await store.listFacts()).some((f) => f.predicate === "WORKS_ON" && f.object === "Atlas"));
});

test("LongTermMemory - a failing memory backend does not fail the run", async () => {
  const agent = new Agent({ name: "A", instructions: "Hi.", model: mock(["ok"]) });
  const result = await agent.run("hello", {
    longTermMemory: {
      retrieveContext: async () => {
        throw new Error("graph down");
      },
      ingest: () => {
        throw new Error("queue down");
      },
    },
  });
  assert.equal(result.success, true);
  const failedSpans = result.trace?.spans.filter((s) => s.error).map((s) => s.name);
  assert.deepEqual(failedSpans, ["memory_read", "memory_write"]);
});
