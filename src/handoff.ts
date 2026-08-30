import { z } from "zod";
import type { Agent } from "./agent.ts";
import type { Tool, ToolSpec } from "./types.ts";
import { zodToJsonSchema } from "./providers/schema.ts";

export const HANDOFF_TOOL_PREFIX = "transfer_to_";

/**
 * Format a target agent name into a normalized handoff tool name.
 */
export function formatHandoffToolName(agentName: string): string {
  const sanitized = agentName.toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  return `${HANDOFF_TOOL_PREFIX}${sanitized}`;
}

/**
 * Check if a tool name is a synthetic handoff tool.
 */
export function isHandoffToolName(toolName: string): boolean {
  return toolName.startsWith(HANDOFF_TOOL_PREFIX);
}

/**
 * Extract target agent name from a handoff tool name.
 */
export function extractTargetAgentName(toolName: string): string {
  return toolName.slice(HANDOFF_TOOL_PREFIX.length);
}

/**
 * Handoff tool input schema.
 */
export const HandoffInputSchema = z.object({
  reason: z.string().optional().describe("Reason for transferring to the specialist agent"),
});

export type HandoffInput = z.infer<typeof HandoffInputSchema>;

export interface HandoffTool extends Tool<HandoffInput, { transferredTo: string; reason?: string }> {
  isHandoff: true;
  targetAgent: Agent<any>;
}

/**
 * Create a synthetic handoff tool for a target agent.
 */
export function createHandoffTool(targetAgent: Agent<any>): HandoffTool {
  const name = formatHandoffToolName(targetAgent.name);
  const description = `Transfer the conversation to ${targetAgent.name}. Call this when the user request requires ${targetAgent.name}'s expertise.`;

  return {
    name,
    description,
    inputSchema: HandoffInputSchema,
    isHandoff: true,
    targetAgent,
    execute: async (input: HandoffInput) => {
      return {
        transferredTo: targetAgent.name,
        reason: input.reason,
      };
    },
    toJSONSchema: () => zodToJsonSchema(HandoffInputSchema),
  };
}

/**
 * Get all handoff tools for a given agent.
 */
export function getAgentHandoffTools(agent: Agent<any>): HandoffTool[] {
  if (!agent.handoffs || agent.handoffs.length === 0) {
    return [];
  }
  return agent.handoffs.map((target) => createHandoffTool(target));
}

/**
 * Combine standard tools and synthetic handoff tools into unified ToolSpec list for the provider.
 */
export function buildCombinedToolSpecs(agent: Agent<any>): {
  toolSpecs: ToolSpec[];
  handoffTools: HandoffTool[];
  allTools: (Tool | HandoffTool)[];
} {
  const handoffTools = getAgentHandoffTools(agent);
  const allTools: (Tool | HandoffTool)[] = [...agent.tools, ...handoffTools];

  const toolSpecs: ToolSpec[] = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.toJSONSchema ? t.toJSONSchema() : { type: "object" },
  }));

  return { toolSpecs, handoffTools, allTools };
}
