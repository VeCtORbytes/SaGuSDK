import {
  Agent,
  InMemoryGraphMemoryStore,
  createGraphMemoryTools,
  mock,
} from "../../src/index.ts";

/**
 * Example 4: Graph Long-Term Memory & Semantic Recall
 *
 * Demonstrates:
 * 1. Semantic Knowledge Graph storage (facts & relationships) beyond flat conversation history
 * 2. Autonomously storing triplets (subject -> predicate -> object) via `remember_fact` tool
 * 3. Querying facts in future, completely separate sessions using `recall_facts` tool
 * 4. Pluggable: InMemoryGraphMemoryStore for local testing, Neo4jGraphMemoryStore for production
 */

// 1. Initialize Graph Memory Store (InMemory for zero-setup demo; Neo4j when NEO4J_URI set)
const graphStore = new InMemoryGraphMemoryStore();

// 2. Generate standard `remember_fact` and `recall_facts` tools
const graphTools = createGraphMemoryTools(graphStore);

async function main() {
  console.log("=== Sagu SDK: Example 04 - Semantic Graph Long-Term Memory ===");

  // --- Session 1: User mentions preferences and relationships ---
  console.log("\n[Session 1]: User reveals tech preferences to Agent");
  const session1Agent = new Agent({
    name: "ProfileCollector",
    instructions:
      "You are a developer assistant. When users state preferences or project details, store them in long-term memory using remember_fact.",
    model: mock([
      {
        toolCalls: [
          {
            id: "call_rem_1",
            name: "remember_fact",
            arguments: {
              subject: "User",
              predicate: "PREFERS_LANGUAGE",
              object: "TypeScript",
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            id: "call_rem_2",
            name: "remember_fact",
            arguments: {
              subject: "User",
              predicate: "PRIMARY_DATABASE",
              object: "PostgreSQL with Neo4j",
            },
          },
        ],
      },
      "I have stored your preferences for TypeScript and PostgreSQL with Neo4j in long-term memory.",
    ]),
    tools: graphTools,
  });

  const res1 = await session1Agent.run(
    "Hi! For my new project, I exclusively write TypeScript and our primary database setup is PostgreSQL with Neo4j."
  );

  if (res1.success) {
    console.log("Session 1 Output:\n", res1.output);
  } else {
    console.error("Session 1 Failed:", res1.error);
  }

  console.log("\nCurrent Graph Triplet Count:", graphStore.allEntries.length);
  for (const entry of graphStore.allEntries) {
    console.log(`  ( :${entry.subject} ) -[ :${entry.predicate} ]-> ( :${entry.object} )`);
  }

  // --- Session 2: Days later, in a brand new session with NO prior chat history ---
  console.log("\n[Session 2]: Brand new session with zero previous chat history");
  const session2Agent = new Agent({
    name: "ArchitectAssistant",
    instructions:
      "You are a solutions architect. Before designing architectures, consult long-term memory using recall_facts.",
    model: mock([
      {
        toolCalls: [
          {
            id: "call_rec_1",
            name: "recall_facts",
            arguments: {
              about: "language database preference",
            },
          },
        ],
      },
      "Based on your profile in memory, I recommend building your service with a TypeScript backend connecting to PostgreSQL for relational data and Neo4j for relationship querying.",
    ]),
    tools: graphTools,
  });

  const res2 = await session2Agent.run("What tech stack do you recommend for my next microservice?");

  if (res2.success) {
    console.log("Session 2 Output:\n", res2.output);
    console.log("\nTool Results in Session 2:");
    const toolResultMsg = res2.messages.find((m) => m.role === "tool");
    console.log("Recalled Facts:", toolResultMsg?.toolResult?.result);
  } else {
    console.error("Session 2 Failed:", res2.error);
  }
}

main().catch(console.error);
