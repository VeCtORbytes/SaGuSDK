# Memory & Sessions

SAGU distinguishes between two fundamentally different types of memory:
1. **Raw Conversation Sessions (`SessionStore`)**: Sequential chat messages tied to a specific `sessionId`.
2. **Semantic Graph Memory (`GraphMemoryStore`)**: Cross-session knowledge graph of facts, entities, and relationships.

---

## 1. Raw Conversation Sessions (`SessionStore`)

SAGU ships with three zero-leak session adapters:

### In-Memory (`InMemorySession`)
Stores messages in RAM. Useful for unit testing and ephemeral sessions:
```typescript
import { InMemorySession } from "sagu-sdk";

const store = new InMemorySession({ maxMessagesPerSession: 50 });
```

### JSON File (`FileSession`)
Persists conversations as human-readable JSON files:
```typescript
import { FileSession } from "sagu-sdk";

const store = new FileSession({ storageDir: "./data/sessions" });
```

### SQLite (`SqliteSession`) — Zero Dependencies!
Uses Node 25's built-in `node:sqlite` module for fast, durable relational storage without installing `better-sqlite3` or SQLite binary packages:
```typescript
import { SqliteSession } from "sagu-sdk";

// In-memory or file-backed database
const store = new SqliteSession({ filename: "./data/conversations.db" });
```

### Usage with an Agent:
```typescript
const result = await agent.run("Hello, my name is Alex.", {
  sessionId: "user_session_101",
  sessionStore: store,
});

// Follow-up call reloads prior context automatically:
const followUp = await agent.run("What was my name again?", {
  sessionId: "user_session_101",
  sessionStore: store,
});
console.log(followUp.output); // "Your name is Alex."
```

---

## 2. Semantic Graph Long-Term Memory (`GraphMemoryStore`)

Unlike flat message logs that fall out of LLM context windows, **Graph Memory** stores atomic knowledge triplets `(subject -> predicate -> object)`.

### Automatic Store Factory:
```typescript
import { createAutoGraphMemoryStore, createGraphMemoryTools } from "sagu-sdk";

// Automatically connects to Neo4j if NEO4J_URI is set; otherwise falls back to InMemory
const graphStore = await createAutoGraphMemoryStore();
const memoryTools = createGraphMemoryTools(graphStore);

const agent = new Agent({
  name: "KnowledgeAgent",
  instructions: "Help the user. Store key preferences using remember_fact and query using recall_facts.",
  model: anthropic(),
  tools: [...memoryTools],
});
```

### Generated Graph Tools:
- **`remember_fact`**: Store triplets into the graph:
  `{ subject: "User", predicate: "PREFERS_FRAMEWORK", object: "React with TypeScript" }`
- **`recall_facts`**: Semantic fuzzy search across stored knowledge:
  `{ about: "framework preference" }`
