import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import { mock } from "../src/providers/mock.ts";
import { StructuredOutputError } from "../src/errors.ts";
import {
  extractJsonFromText,
  formatZodIssues,
  parseStructuredOutput,
} from "../src/structuredOutput.ts";

test("Structured Output - extraction utilities", () => {
  // Direct JSON
  assert.deepEqual(extractJsonFromText('{"key": "value"}'), { key: "value" });

  // Markdown fence
  assert.deepEqual(
    extractJsonFromText('```json\n{"score": 95, "passed": true}\n```'),
    { score: 95, passed: true }
  );

  // Embedded in prose
  assert.deepEqual(
    extractJsonFromText('Here is your requested object: {"status": "ok"} Thank you!'),
    { status: "ok" }
  );

  // Array JSON
  assert.deepEqual(extractJsonFromText('[1, 2, 3]'), [1, 2, 3]);

  // Invalid JSON throws
  assert.throws(() => extractJsonFromText("Not JSON at all"), /Failed to parse valid JSON/);
});

test("Structured Output - parseStructuredOutput and issue formatting", () => {
  const UserSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email(),
  });

  // Valid
  const valid = parseStructuredOutput(
    '{"name": "Alice", "age": 30, "email": "alice@example.com"}',
    UserSchema
  );
  assert.equal(valid.success, true);
  if (valid.success) {
    assert.deepEqual(valid.data, { name: "Alice", age: 30, email: "alice@example.com" });
  }

  // Schema mismatch
  const invalid = parseStructuredOutput(
    '{"name": "Alice", "age": "thirty", "email": "not-an-email"}',
    UserSchema
  );
  assert.equal(invalid.success, false);
  if (!invalid.success) {
    assert(invalid.error instanceof StructuredOutputError);
    assert(invalid.repairPrompt.includes("email"));
  }

  // formatZodIssues direct
  const issues = [
    { code: "invalid_type" as const, expected: "number" as const, received: "string" as const, path: ["age"], message: "Expected number, received string" },
  ];
  const formatted = formatZodIssues(issues as any);
  assert(formatted.includes("Field 'age': Expected number"));
});

test("Structured Output - agent returns valid typed output on first turn", async () => {
  const ExtractionSchema = z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    confidence: z.number(),
    keywords: z.array(z.string()),
  });

  type Extraction = z.infer<typeof ExtractionSchema>;

  const model = mock([
    JSON.stringify({
      sentiment: "positive",
      confidence: 0.98,
      keywords: ["fast", "intuitive", "reliable"],
    }),
  ]);

  const agent = new Agent<Extraction>({
    name: "sentiment_agent",
    instructions: "Extract sentiment and keywords.",
    model,
    outputSchema: ExtractionSchema,
  });

  const res = await agent.run("This product is blazing fast and extremely reliable!");

  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output.sentiment, "positive");
    assert.equal(res.output.confidence, 0.98);
    assert.deepEqual(res.output.keywords, ["fast", "intuitive", "reliable"]);
    assert.equal(res.turns, 1);
  }
});

test("Structured Output - automatic self-repair retry recovers invalid output", async () => {
  const MovieSchema = z.object({
    title: z.string(),
    year: z.number(),
    director: z.string(),
  });

  type Movie = z.infer<typeof MovieSchema>;

  const model = mock([
    // Turn 1: Model returns invalid schema (year as string, missing director)
    JSON.stringify({
      title: "Inception",
      year: "2010",
    }),
    // Turn 2: After repair prompt, model returns valid schema
    JSON.stringify({
      title: "Inception",
      year: 2010,
      director: "Christopher Nolan",
    }),
  ]);

  const agent = new Agent<Movie>({
    name: "movie_agent",
    instructions: "Extract movie metadata.",
    model,
    outputSchema: MovieSchema,
    maxRepairAttempts: 2,
  });

  const res = await agent.run("Tell me about Inception directed by Christopher Nolan in 2010.");

  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.output.title, "Inception");
    assert.equal(res.output.year, 2010);
    assert.equal(res.output.director, "Christopher Nolan");
    assert.equal(res.turns, 2);
    // Check that repair prompt was injected into messages
    const repairMessage = res.messages.find(
      (m) =>
        m.role === "user" &&
        m.content.includes("did not conform to the required JSON schema")
    );
    assert(repairMessage, "Repair prompt should be recorded in messages");
  }
});

test("Structured Output - exhausted repair attempts returns StructuredOutputError", async () => {
  const StrictSchema = z.object({
    id: z.number(),
  });

  const model = mock({
    defaultResponse: "Sorry, I cannot format this as JSON.",
  });

  const agent = new Agent({
    name: "strict_agent",
    instructions: "Return id.",
    model,
    outputSchema: StrictSchema,
    maxRepairAttempts: 2,
  });

  const res = await agent.run("Give me an ID");

  assert.equal(res.success, false);
  if (!res.success) {
    assert(res.error instanceof StructuredOutputError);
    assert.equal(res.error.code, "SAGU_STRUCTURED_OUTPUT_ERROR");
  }
});
