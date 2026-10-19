# Structured Output & Schema Repair

SAGU provides end-to-end type safety by pairing generic TypeScript types with Zod validation and automated self-repair retry loops.

---

## Defining an Output Schema

Define a Zod schema and pass it as `outputSchema` to `new Agent<TOutput>()`:

```typescript
import { z } from "zod";
import { Agent, anthropic } from "sagu-sdk";

const BugReportSchema = z.object({
  title: z.string().describe("Concise bug title"),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  stepsToReproduce: z.array(z.string()),
  affectedModule: z.string(),
});

type BugReport = z.infer<typeof BugReportSchema>;

const bugTriageAgent = new Agent<BugReport>({
  name: "BugTriager",
  instructions: "Parse the user's issue and output structured bug data.",
  model: anthropic(),
  outputSchema: BugReportSchema,
  maxRepairAttempts: 2, // Retries up to 2 times on validation error
});
```

---

## Type-Safe Results

When `outputSchema` is provided, TypeScript automatically types `result.output`:

```typescript
const result = await bugTriageAgent.run("The login button crashes on Safari 17!");

if (result.success) {
  // result.output is strictly typed as BugReport:
  console.log(result.output.severity);          // "HIGH" | "CRITICAL" | etc.
  console.log(result.output.stepsToReproduce);   // string[]
} else {
  console.error("Failed to parse output:", result.error);
}
```

---

## The Automatic Self-Repair Retry Loop

If a model produces invalid JSON or misses required fields:
1. SAGU extracts JSON using multi-pattern extraction (raw JSON, markdown code fences, and bracket scans).
2. Runs `schema.safeParse()`.
3. If validation fails, SAGU formats the exact missing/invalid fields into a targeted diagnostic prompt:
   ```
   Your previous response did not conform to the required JSON schema.
   Validation errors:
   - Field 'severity': Expected 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', received 'URGENT'
   - Field 'stepsToReproduce': Required
   Please correct the errors and respond with ONLY valid JSON.
   ```
4. Automatically resubmits to the model for a self-repair attempt.
5. If the model fixes the error, the run succeeds cleanly.
6. If `maxRepairAttempts` is exhausted without a valid structure, returns `{ success: false, error: StructuredOutputError }`.
