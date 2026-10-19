/**
 * Runs against a real Neo4j. Skipped unless NEO4J_URI is set:
 *
 *   docker run -d --rm -p 7687:7687 -e NEO4J_AUTH=neo4j/sagu-test-pass neo4j:5
 *   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=sagu-test-pass node --test test/neo4j.integration.test.ts
 *
 * WARNING: deletes every :Entity node in the target database.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GraphMaintainer,
  LongTermMemory,
  Neo4jGraphMemoryStore,
  RelationshipBuilder,
  mock,
} from "../src/index.ts";

const uri = process.env.NEO4J_URI;
const DAY = 24 * 60 * 60 * 1000;

test("Neo4j - store, three processes and retrieval end to end", { skip: !uri }, async () => {
  const store = new Neo4jGraphMemoryStore({ uri: uri! });
  const reset = async () => {
    for (const f of await store.listFacts()) await store.forget(f);
  };
  await reset();

  try {
    // Store semantics
    await store.remember({ subject: "User", predicate: "USES", object: "Neo4j", confidence: 0.6, createdAt: 1000, updatedAt: 1000 });
    await store.remember({ subject: "User", predicate: "USES", object: "Neo4j", confidence: 0.9 });
    let [fact] = await store.listFacts();
    assert.equal(fact?.mentions, 2);
    assert.equal(fact?.confidence, 0.9);
    assert.equal(fact?.createdAt, 1000);
    assert.equal(typeof fact?.updatedAt, "number");
    assert.equal((await store.recall({ about: "what database does the user use neo4j" })).length, 1, "tokenized recall");

    // Process 1: extraction through LongTermMemory
    const memory = new LongTermMemory({
      store,
      model: mock([
        JSON.stringify({
          facts: [
            { subject: "User", predicate: "works on", object: "Atlas", confidence: 0.95 },
            { subject: "Atlas", predicate: "USES", object: "neo4j", confidence: 0.9 },
            { subject: "User", predicate: "LIVES_IN", object: "Berlin", confidence: 0.9 },
          ],
        }),
      ]),
    });
    await store.remember({ subject: "User", predicate: "LIVES_IN", object: "Paris", updatedAt: Date.now() - 10 * DAY });
    await store.remember({ subject: "User", predicate: "USED", object: "jQuery", updatedAt: Date.now() - 120 * DAY });
    memory.ingest([
      { role: "user", content: "I work on Atlas, it runs on Neo4j. I moved to Berlin." },
      { role: "assistant", content: "Got it." },
    ]);

    // Processes 2 and 3 via flush(): extract → infer → maintain
    await memory.flush();
    const facts = (await store.listFacts()).map((f) => `${f.subject} ${f.predicate} ${f.object}`).sort();
    assert.deepEqual(facts, [
      "Atlas USES Neo4j", // "neo4j" merged into canonical "Neo4j"
      "User LIVES_IN Berlin", // Paris resolved away
      "User USES Neo4j", // stated fact kept, not overwritten by inference
      "User WORKS_ON Atlas",
      // jQuery pruned as stale
    ]);

    const orphan = await store.recall({ about: "paris" });
    assert.equal(orphan.length, 0);

    // Inference on its own
    await store.remember({ subject: "Alice", predicate: "KNOWS", object: "Bob" });
    assert.equal(await new RelationshipBuilder({ store }).runOnce(), 1);
    assert.equal((await store.recall({ about: "bob" })).length, 2);
    assert.equal(await new GraphMaintainer({ store }).runOnce(), 0, "clean graph needs no maintenance");

    // Retrieval
    const ctx = await memory.retrieveContext("What stack does Atlas use?");
    assert.match(ctx.text, /Atlas USES Neo4j/);
  } finally {
    await reset();
    await store.close();
  }
});
