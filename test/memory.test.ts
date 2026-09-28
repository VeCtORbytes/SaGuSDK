import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemorySession } from "../src/memory/inMemory.ts";
import { FileSession } from "../src/memory/file.ts";
import { SqliteSession } from "../src/memory/sqlite.ts";
import { InMemoryGraphMemoryStore } from "../src/memory/graphMemory.ts";
import { Neo4jGraphMemoryStore } from "../src/memory/neo4jGraphMemory.ts";
import { createGraphMemoryTools } from "../src/memory/graphMemoryTools.ts";
import { Agent } from "../src/agent.ts";
import { mock } from "../src/providers/mock.ts";
import type { Message } from "../src/types.ts";

test("InMemorySession - basic operations and max message pruning", async () => {
  const store = new InMemorySession({ maxMessagesPerSession: 3 });

  await store.appendMessages("sess_1", [
    { role: "user", content: "Msg 1" },
    { role: "assistant", content: "Msg 2" },
  ]);

  let history = await store.getHistory("sess_1");
  assert.equal(history.length, 2);
  assert.equal(history[0]?.content, "Msg 1");

  // Append 2 more -> total 4 -> should prune to last 3
  await store.appendMessages("sess_1", [
    { role: "user", content: "Msg 3" },
    { role: "assistant", content: "Msg 4" },
  ]);

  history = await store.getHistory("sess_1");
  assert.equal(history.length, 3);
  assert.equal(history[0]?.content, "Msg 2");
  assert.equal(history[2]?.content, "Msg 4");

  // Clear
  await store.clear("sess_1");
  history = await store.getHistory("sess_1");
  assert.equal(history.length, 0);
});

test("FileSession - JSON persistence across store instances", async () => {
  const tempDir = join(tmpdir(), `sagu_test_${Date.now()}`);
  const store1 = new FileSession({ storageDir: tempDir });

  const messages: Message[] = [
    { role: "user", content: "Hello disk" },
    { role: "assistant", content: "Hello from memory" },
  ];

  await store1.appendMessages("session_abc", messages);

  // New instance pointing to same dir
  const store2 = new FileSession({ storageDir: tempDir });
  const retrieved = await store2.getHistory("session_abc");

  assert.equal(retrieved.length, 2);
  assert.equal(retrieved[0]?.content, "Hello disk");

  await store2.clear("session_abc");
  const afterClear = await store2.getHistory("session_abc");
  assert.equal(afterClear.length, 0);

  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("SqliteSession - zero-dependency node:sqlite persistence", async () => {
  // 1. In-memory SQLite test
  const memorySqlite = new SqliteSession({ filename: ":memory:" });
  await memorySqlite.appendMessages("sess_sqlite", [
    {
      role: "user",
      content: "Query 1",
      metadata: { priority: "high" },
    },
    {
      role: "assistant",
      content: "Answer 1",
      toolCalls: [{ id: "tc_1", name: "test_tool", arguments: { a: 1 } }],
    },
  ]);

  const history = await memorySqlite.getHistory("sess_sqlite");
  assert.equal(history.length, 2);
  assert.equal(history[0]?.content, "Query 1");
  assert.deepEqual(history[0]?.metadata, { priority: "high" });
  assert.equal(history[1]?.toolCalls?.[0]?.name, "test_tool");

  await memorySqlite.clear("sess_sqlite");
  assert.equal((await memorySqlite.getHistory("sess_sqlite")).length, 0);
  memorySqlite.close();

  // 2. File-backed SQLite test
  const dbFile = join(tmpdir(), `sagu_sqlite_${Date.now()}.db`);
  const sqliteFile1 = new SqliteSession({ filename: dbFile });
  await sqliteFile1.appendMessages("user_100", [{ role: "user", content: "Persisted SQLite message" }]);
  sqliteFile1.close();

  const sqliteFile2 = new SqliteSession({ filename: dbFile });
  const fileHistory = await sqliteFile2.getHistory("user_100");
  assert.equal(fileHistory.length, 1);
  assert.equal(fileHistory[0]?.content, "Persisted SQLite message");
  sqliteFile2.close();

  if (existsSync(dbFile)) {
    rmSync(dbFile, { force: true });
  }
});

test("InMemoryGraphMemoryStore - remember and recall semantic triplets", async () => {
  const graphStore = new InMemoryGraphMemoryStore();

  await graphStore.remember({
    subject: "Alice",
    predicate: "PREFERS_FRAMEWORK",
    object: "React",
  });

  await graphStore.remember({
    subject: "Alice",
    predicate: "WORKS_AT",
    object: "Acme Corp",
  });

  await graphStore.remember({
    subject: "Bob",
    predicate: "PREFERS_FRAMEWORK",
    object: "Vue",
  });

  // Recall by entity
  const aliceFacts = await graphStore.recall({ about: "Alice" });
  assert.equal(aliceFacts.length, 2);

  // Recall by relationship / topic
  const frameworkFacts = await graphStore.recall({ about: "framework" });
  assert.equal(frameworkFacts.length, 2);

  // Recall by target object
  const acmeFacts = await graphStore.recall({ about: "Acme" });
  assert.equal(acmeFacts.length, 1);
  assert.equal(acmeFacts[0]?.subject, "Alice");
  assert.equal(acmeFacts[0]?.object, "Acme Corp");
});

test("Graph Memory Tools + Agent Integration - cross-session long-term recall", async () => {
  const graphStore = new InMemoryGraphMemoryStore();
  const graphTools = createGraphMemoryTools(graphStore);

  // Session 1: User tells agent a preference, agent explicitly stores it in graph memory
  const agent1 = new Agent({
    name: "knowledge_assistant",
    instructions: "Help user and remember key preferences in long-term memory.",
    model: mock([
      {
        toolCalls: [
          {
            id: "call_remember_1",
            name: "remember_fact",
            arguments: {
              subject: "User",
              predicate: "PREFERS_THEME",
              object: "Dark Mode",
            },
          },
        ],
      },
      "I have recorded that you prefer Dark Mode in your preferences.",
    ]),
    tools: graphTools,
  });

  const res1 = await agent1.run("Please remember that I always prefer Dark Mode.");
  assert.equal(res1.success, true);
  if (res1.success) {
    assert.equal(res1.turns, 2);
  }

  // Verify it exists in graph store
  const stored = await graphStore.recall({ about: "theme" });
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.object, "Dark Mode");

  // Session 2: In a completely distinct session without previous chat history, agent recalls preference
  const agent2 = new Agent({
    name: "knowledge_assistant",
    instructions: "Answer user queries by recalling facts when needed.",
    model: mock([
      {
        toolCalls: [
          {
            id: "call_recall_1",
            name: "recall_facts",
            arguments: { about: "theme preference" },
          },
        ],
      },
      "Based on your profile, you prefer Dark Mode.",
    ]),
    tools: graphTools,
  });

  const res2 = await agent2.run("What theme do I like?");
  assert.equal(res2.success, true);
  if (res2.success) {
    assert.equal(res2.output, "Based on your profile, you prefer Dark Mode.");
    assert.equal(res2.turns, 2);
    assert.equal(res2.messages[2]?.role, "tool");
    assert.equal(res2.messages[2]?.toolResult?.name, "recall_facts");
  }
});

test("Neo4jGraphMemoryStore - mock driver query execution", async () => {
  let executedCypher = "";
  let queryParams: Record<string, any> = {};

  const mockDriver = {
    session: () => ({
      run: async (cypher: string, params: any) => {
        executedCypher = cypher;
        queryParams = params;
        return {
          records: [
            {
              get: (key: string) => {
                if (key === "subject") return "Postgres";
                if (key === "predicate") return "USES_PORT";
                if (key === "object") return "5432";
                return null;
              },
            },
          ],
        };
      },
      close: async () => {},
    }),
    close: async () => {},
  };

  const neoStore = new Neo4jGraphMemoryStore({
    uri: "bolt://localhost:7687",
    driver: mockDriver,
  });

  await neoStore.remember({
    subject: "Postgres",
    predicate: "USES_PORT",
    object: "5432",
  });

  assert(executedCypher.includes("MERGE (s:Entity"));
  assert.equal(queryParams.subject, "Postgres");

  const results = await neoStore.recall({ about: "Postgres", limit: 5 });
  assert(executedCypher.includes("MATCH (s:Entity)"));
  assert.equal(results.length, 1);
  assert.equal(results[0]?.subject, "Postgres");
  assert.equal(results[0]?.object, "5432");

  await neoStore.close();
});
