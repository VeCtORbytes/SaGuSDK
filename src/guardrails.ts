import type {
  GuardrailContext,
  GuardrailResult,
  InputGuardrail,
  OutputGuardrail,
  ToolGuardrail,
  ToolCall,
} from "./types.ts";

export type {
  GuardrailContext,
  GuardrailResult,
  InputGuardrail,
  OutputGuardrail,
  ToolGuardrail,
};

/**
 * Creates an input guardrail that tests user input against a regular expression.
 * Can either block matching inputs or sanitize them with a replacement.
 */
export function createRegexInputGuardrail(options: {
  pattern: RegExp;
  reason?: string;
  replaceWith?: string;
}): InputGuardrail {
  return async (input: string) => {
    if (options.replaceWith !== undefined) {
      if (options.pattern.test(input)) {
        const modified = input.replace(options.pattern, options.replaceWith);
        return { pass: true, modified };
      }
      return { pass: true };
    }

    if (options.pattern.test(input)) {
      return {
        pass: false,
        reason: options.reason ?? `Input matched blocked pattern ${options.pattern}`,
      };
    }

    return { pass: true };
  };
}

/**
 * Creates an output guardrail that tests model output against a regular expression.
 * Can either block matching outputs or sanitize them with a replacement.
 */
export function createRegexOutputGuardrail(options: {
  pattern: RegExp;
  reason?: string;
  replaceWith?: string;
}): OutputGuardrail {
  return async (output: string) => {
    if (options.replaceWith !== undefined) {
      if (options.pattern.test(output)) {
        const modified = output.replace(options.pattern, options.replaceWith);
        return { pass: true, modified };
      }
      return { pass: true };
    }

    if (options.pattern.test(output)) {
      return {
        pass: false,
        reason: options.reason ?? `Output matched blocked pattern ${options.pattern}`,
      };
    }

    return { pass: true };
  };
}

/**
 * Creates a length guardrail that ensures input or output is within min/max bounds.
 */
export function createLengthGuardrail(options: {
  minLength?: number;
  maxLength?: number;
  stage?: "input" | "output";
}): (text: string) => GuardrailResult<string> {
  return (text: string) => {
    if (options.minLength !== undefined && text.length < options.minLength) {
      return {
        pass: false,
        reason: `Text length (${text.length}) is below required minimum of ${options.minLength} characters.`,
      };
    }
    if (options.maxLength !== undefined && text.length > options.maxLength) {
      return {
        pass: false,
        reason: `Text length (${text.length}) exceeds maximum limit of ${options.maxLength} characters.`,
      };
    }
    return { pass: true };
  };
}

/**
 * Creates a tool guardrail that ensures only approved tools are called.
 */
export function createToolAllowlistGuardrail(allowedToolNames: string[]): ToolGuardrail {
  const allowedSet = new Set(allowedToolNames);
  return async (toolCall: ToolCall) => {
    if (!allowedSet.has(toolCall.name)) {
      return {
        pass: false,
        reason: `Tool '${toolCall.name}' is not in the allowlist [${allowedToolNames.join(", ")}]`,
      };
    }
    return { pass: true };
  };
}

/**
 * Creates a tool guardrail that validates tool parameters against custom logic.
 */
export function createToolParameterGuardrail(
  toolName: string,
  validator: (args: Record<string, unknown> | string) => boolean | Promise<boolean>,
  reason?: string
): ToolGuardrail {
  return async (toolCall: ToolCall) => {
    if (toolCall.name === toolName) {
      const isValid = await validator(toolCall.arguments);
      if (!isValid) {
        return {
          pass: false,
          reason: reason ?? `Tool call '${toolName}' parameters failed guardrail validation`,
        };
      }
    }
    return { pass: true };
  };
}
