# Tools & Function Calling

Tools in SAGU allow agents to fetch external data, execute computations, and trigger side-effects.

---

## Defining a Tool

Tools are declared using `defineTool()`. It validates configuration at definition time, infers TypeScript types from Zod, and automatically produces JSON Schemas for model providers:

```typescript
import { z } from "zod";
import { defineTool } from "sagu-sdk";

export const searchDatabaseTool = defineTool({
  name: "search_database",
  description: "Search customer records by name or email.",
  input: z.object({
    query: z.string().min(2).describe("Search search query"),
    limit: z.number().int().positive().default(5).describe("Max results"),
  }),
  timeoutMs: 3000, // Optional timeout in ms
  requiresApproval: false, // Optional human-in-the-loop approval
  execute: async ({ query, limit }, context) => {
    // context contains { agentName, runId, abortSignal }
    return [
      { id: "cust_1", name: query, status: "ACTIVE" },
    ];
  },
});
```

---

## Tool Execution Features

### 1. Automatic Schema Validation
If the LLM provides arguments that do not conform to the Zod schema:
- SAGU intercepts the validation failure.
- Returns an informative error message back to the LLM as a `tool` role message.
- The LLM can correct its arguments on the next turn.

### 2. Execution Timeouts (`timeoutMs`)
Set `timeoutMs` to prevent hung external requests from locking the agent loop:
```typescript
const slowTool = defineTool({
  name: "fetch_large_dataset",
  description: "Fetch data",
  input: z.object({ url: z.string() }),
  timeoutMs: 5000, // Throws TimeoutError if not resolved within 5s
  execute: async ({ url }) => { /* ... */ },
});
```

### 3. Human-in-the-Loop Approval (`requiresApproval`)
For sensitive operations (e.g. deleting resources, transferring money, modifying production configs):

```typescript
const deleteDatabaseTool = defineTool({
  name: "delete_table",
  description: "Drop a database table",
  input: z.object({ tableName: z.string() }),
  requiresApproval: true,
  execute: async ({ tableName }) => ({ dropped: tableName }),
});
```

When an agent invokes this tool, the runner queries the `onApprovalRequired` callback provided in `RunOptions`:

```typescript
const result = await agent.run("Drop the users table", {
  onApprovalRequired: async (toolCall) => {
    // Show prompt to user or inspect payload
    console.log(`Action requested: ${toolCall.name}`, toolCall.arguments);
    return false; // Denied!
  },
});
```

> **Security Rule:** If a tool has `requiresApproval: true` and **no** `onApprovalRequired` callback was provided, SAGU **automatically rejects** the execution. It never silently approves.
