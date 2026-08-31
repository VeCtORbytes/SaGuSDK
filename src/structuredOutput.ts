import type { z } from "zod";
import { StructuredOutputError } from "./errors.ts";

/**
 * Extract JSON object or array from a raw text string, supporting markdown code blocks.
 */
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to substring/markdown extraction
  }

  // Check for ```json ... ``` or ``` ... ``` code fence
  const markdownMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (markdownMatch && markdownMatch[1]) {
    try {
      return JSON.parse(markdownMatch[1].trim());
    } catch {
      // Continue to bracket search
    }
  }

  // Find first '{' or '[' and last '}' or ']'
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let startIdx = -1;

  if (firstBrace !== -1 && firstBracket !== -1) {
    startIdx = Math.min(firstBrace, firstBracket);
  } else if (firstBrace !== -1) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  const lastBrace = trimmed.lastIndexOf("}");
  const lastBracket = trimmed.lastIndexOf("]");
  const endIdx = Math.max(lastBrace, lastBracket);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const candidate = trimmed.substring(startIdx, endIdx + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // Failed extraction
    }
  }

  throw new Error(`Failed to parse valid JSON from model response: "${trimmed.slice(0, 100)}..."`);
}

/**
 * Formats Zod validation issues into a human- and LLM-readable summary string.
 */
export function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `- Field '${path}': ${issue.message}`;
    })
    .join("\n");
}

/**
 * Builds a targeted prompt for model self-repair when schema validation fails.
 */
export function buildSchemaRepairPrompt(options: {
  rawOutput: string;
  errorMessage: string;
  schemaJson?: Record<string, unknown>;
}): string {
  const schemaStr = options.schemaJson
    ? `\nExpected JSON Schema:\n${JSON.stringify(options.schemaJson, null, 2)}`
    : "";

  return (
    `Your previous response did not conform to the required JSON schema.\n` +
    `Validation errors:\n${options.errorMessage}${schemaStr}\n\n` +
    `Please correct the errors and respond with ONLY valid JSON.`
  );
}

/**
 * Validate raw output against a Zod schema.
 */
export function parseStructuredOutput<T>(
  rawText: string,
  schema: z.ZodType<T>,
  attemptCount = 1
): { success: true; data: T } | { success: false; error: StructuredOutputError; repairPrompt: string } {
  let parsedJson: unknown;
  try {
    parsedJson = extractJsonFromText(rawText);
  } catch (err: any) {
    const error = new StructuredOutputError(
      `Failed to parse JSON from output: ${err.message}`,
      {
        rawOutput: rawText,
        attempts: attemptCount,
      }
    );
    const repairPrompt = buildSchemaRepairPrompt({
      rawOutput: rawText,
      errorMessage: "Output is not valid JSON.",
    });
    return { success: false, error, repairPrompt };
  }

  const validation = schema.safeParse(parsedJson);
  if (!validation.success) {
    const formattedErrors = formatZodIssues(validation.error.issues);
    const error = new StructuredOutputError(
      `Schema validation failed:\n${formattedErrors}`,
      {
        rawOutput: rawText,
        zodIssues: validation.error.issues,
        attempts: attemptCount,
      }
    );
    const repairPrompt = buildSchemaRepairPrompt({
      rawOutput: rawText,
      errorMessage: formattedErrors,
    });
    return { success: false, error, repairPrompt };
  }

  return { success: true, data: validation.data };
}
