import { z } from "zod";
import { defineTool } from "../tool.ts";
import type { Tool } from "../types.ts";
import type { GraphMemoryStore } from "./types.ts";

/**
 * Creates standard `remember_fact` and `recall_facts` tools bound to a GraphMemoryStore.
 * These tools allow any Sagu agent to autonomously store and query long-term semantic knowledge.
 */
export function createGraphMemoryTools(store: GraphMemoryStore): Tool[] {
  const rememberTool = defineTool({
    name: "remember_fact",
    description:
      "Store a long-term semantic fact into the knowledge graph (subject -> predicate -> object). Use this when the user reveals a key preference, constraint, or fact worth remembering across future sessions.",
    input: z.object({
      subject: z
        .string()
        .describe("The core entity or person (e.g., 'User', 'Alice', 'Database')"),
      predicate: z
        .string()
        .describe("The relationship or attribute in uppercase (e.g., 'PREFERS', 'LIVES_IN', 'USES_VERSION')"),
      object: z
        .string()
        .describe("The target value, entity, or attribute (e.g., 'TypeScript', 'Seattle', 'Postgres 16')"),
    }),
    execute: async ({ subject, predicate, object }) => {
      await store.remember({ subject, predicate, object });
      return {
        stored: true,
        fact: `${subject} ${predicate} ${object}`,
        message: `Successfully remembered: ${subject} ${predicate} ${object}`,
      };
    },
  });

  const recallTool = defineTool({
    name: "recall_facts",
    description:
      "Search and recall long-term semantic facts and relationships from the knowledge graph related to a person, topic, or entity.",
    input: z.object({
      about: z
        .string()
        .describe("Search keyword, entity name, or topic to recall facts about (e.g. 'Alice', 'database preference')"),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Maximum number of facts to return"),
    }),
    execute: async ({ about, limit }) => {
      const facts = await store.recall({ about, limit });
      return {
        count: facts.length,
        facts,
        summary:
          facts.length > 0
            ? facts.map((f) => `• ${f.subject} ${f.predicate} ${f.object}`).join("\n")
            : "No related facts found in long-term memory.",
      };
    },
  });

  return [rememberTool, recallTool];
}
