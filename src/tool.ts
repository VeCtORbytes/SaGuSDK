import type { z } from "zod";
import type { Tool, ToolContext } from "./types.ts";
import { ConfigurationError } from "./errors.ts";
import { zodToJsonSchema } from "./providers/schema.ts";

export interface DefineToolOptions<TInput = any, TOutput = any> {
  /**
   * Unique name of the tool (alphanumeric with underscores or hyphens).
   */
  name: string;
  /**
   * Plain language description of what the tool does and when to call it.
   */
  description: string;
  /**
   * Zod schema specifying the tool's input parameters.
   */
  input: z.ZodType<TInput>;
  /**
   * Execution function called with the parsed and validated input.
   */
  execute: (input: TInput, context?: ToolContext) => Promise<TOutput> | TOutput;
  /**
   * Whether this tool requires human-in-the-loop approval before executing.
   */
  requiresApproval?: boolean;
  /**
   * Optional timeout in milliseconds for this tool's execution.
   */
  timeoutMs?: number;
}

/**
 * Define a tool with full type inference, Zod schema validation, and automatic JSON Schema generation.
 */
export function defineTool<TInput = any, TOutput = any>(
  options: DefineToolOptions<TInput, TOutput>
): Tool<TInput, TOutput> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Tool options must be an object");
  }

  if (!options.name || typeof options.name !== "string" || options.name.trim() === "") {
    throw new ConfigurationError("Tool must have a valid non-empty 'name'");
  }

  const sanitizedName = options.name.trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedName)) {
    throw new ConfigurationError(
      `Tool name '${sanitizedName}' contains invalid characters. Only letters, numbers, underscores, and hyphens are allowed.`
    );
  }

  if (!options.description || typeof options.description !== "string" || options.description.trim() === "") {
    throw new ConfigurationError(`Tool '${sanitizedName}' must have a valid 'description'`);
  }

  if (!options.input) {
    throw new ConfigurationError(`Tool '${sanitizedName}' must specify an 'input' schema (Zod schema)`);
  }

  if (typeof options.execute !== "function") {
    throw new ConfigurationError(`Tool '${sanitizedName}' must have an 'execute' function`);
  }

  return {
    name: sanitizedName,
    description: options.description.trim(),
    inputSchema: options.input,
    execute: options.execute,
    requiresApproval: Boolean(options.requiresApproval),
    timeoutMs: options.timeoutMs,
    toJSONSchema: () => zodToJsonSchema(options.input),
  };
}
