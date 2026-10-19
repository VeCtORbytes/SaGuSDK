import { z } from "zod";
import { Agent, SqliteSession, mock } from "../../src/index.ts";

/**
 * Example 3: Structured Output with Schema Repair & SQLite Session Persistence
 *
 * Demonstrates:
 * 1. Output schema enforcement with automatic self-repair retry loops
 * 2. Typed Agent generics: Agent<LeadProfile> returns typed TypeScript objects
 * 3. Zero-dependency SQLite session persistence across multiple runs using node:sqlite
 */

// 1. Define output schema
const LeadProfileSchema = z.object({
  fullName: z.string().describe("Candidate or contact full name"),
  company: z.string().describe("Company or organization name"),
  role: z.string().describe("Current role or job title"),
  interests: z.array(z.string()).describe("List of tech interests or requirements"),
  confidenceScore: z.number().min(0).max(1).describe("Confidence score between 0 and 1"),
});

type LeadProfile = z.infer<typeof LeadProfileSchema>;

// 2. Mock model that demonstrates schema repair recovery
// Turn 1 returns invalid schema (missing company, confidence as string)
// Turn 2 repairs based on error feedback prompt
const model = mock([
  // Attempt 1: Schema violation
  JSON.stringify({
    fullName: "Elena Rostova",
    role: "VP of Engineering",
    interests: ["Agent SDKs", "TypeScript", "Observability"],
    confidenceScore: "0.95", // invalid type
  }),
  // Attempt 2: Auto-repaired
  JSON.stringify({
    fullName: "Elena Rostova",
    company: "Apex Cloud Systems",
    role: "VP of Engineering",
    interests: ["Agent SDKs", "TypeScript", "Observability"],
    confidenceScore: 0.95,
  }),
  // Second session query response
  JSON.stringify({
    fullName: "Elena Rostova",
    company: "Apex Cloud Systems",
    role: "Chief Technology Officer", // promoted in 2nd message
    interests: ["Agent SDKs", "TypeScript", "Observability", "Neo4j Knowledge Graphs"],
    confidenceScore: 0.99,
  }),
]);

// 3. Initialize Agent with Typed Output Schema
const leadExtractor = new Agent<LeadProfile>({
  name: "LeadProfileExtractor",
  instructions:
    "Extract structured lead profiles from customer transcripts or emails according to the JSON schema.",
  model,
  outputSchema: LeadProfileSchema,
  maxRepairAttempts: 2,
});

async function main() {
  console.log("=== Sagu SDK: Example 03 - Structured Output & SQLite Memory ===");

  // In-memory or file-backed SQLite database (zero dependencies!)
  const sessionStore = new SqliteSession({ filename: ":memory:" });
  const sessionId = "lead_session_user_808";

  console.log("\n--- Run 1: First customer interaction (triggers schema repair retry) ---");
  const run1 = await leadExtractor.run(
    "Hi, I'm Elena Rostova, VP of Engineering at Apex Cloud Systems. We are looking into Agent SDKs with TypeScript and Observability.",
    {
      sessionId,
      sessionStore,
    }
  );

  if (run1.success) {
    console.log("✔ Successfully extracted typed LeadProfile after repair retry:");
    console.log("  Full Name:", run1.output.fullName);
    console.log("  Company:", run1.output.company);
    console.log("  Role:", run1.output.role);
    console.log("  Interests:", run1.output.interests.join(", "));
    console.log("  Confidence:", run1.output.confidenceScore);
    console.log("  Turns Taken:", run1.turns);
  }

  console.log("\n--- Run 2: Follow-up interaction (reloads prior history from SQLite) ---");
  const run2 = await leadExtractor.run(
    "Quick update: I was just promoted to Chief Technology Officer! Also, please add Neo4j Knowledge Graphs to our interest list.",
    {
      sessionId,
      sessionStore,
    }
  );

  if (run2.success) {
    console.log("✔ Successfully updated profile with full conversational context:");
    console.log("  Updated Role:", run2.output.role);
    console.log("  Updated Interests:", run2.output.interests.join(", "));
    console.log("  Messages Persisted in SQLite:", run2.messages.length);
  }

  sessionStore.close();
}

main().catch(console.error);
