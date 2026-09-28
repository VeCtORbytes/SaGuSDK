import type { GraphMemoryEntry, GraphMemoryQuery, GraphMemoryStore } from "./types.ts";

/**
 * In-Memory fake Graph Memory store.
 * Implements the full GraphMemoryStore interface with zero external dependencies.
 * Default in all unit tests and local runs.
 */
export class InMemoryGraphMemoryStore implements GraphMemoryStore {
  private entries: GraphMemoryEntry[] = [];

  async remember(entry: GraphMemoryEntry): Promise<void> {
    const subject = entry.subject.trim();
    const predicate = entry.predicate.trim();
    const object = entry.object.trim();

    // Deduplicate identical triplet
    const existingIndex = this.entries.findIndex(
      (e) =>
        e.subject.toLowerCase() === subject.toLowerCase() &&
        e.predicate.toLowerCase() === predicate.toLowerCase() &&
        e.object.toLowerCase() === object.toLowerCase()
    );

    const newEntry: GraphMemoryEntry = {
      subject,
      predicate,
      object,
      metadata: entry.metadata ? { ...entry.metadata } : undefined,
    };

    if (existingIndex !== -1) {
      this.entries[existingIndex] = newEntry;
    } else {
      this.entries.push(newEntry);
    }
  }

  async recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]> {
    const aboutLower = query.about.toLowerCase().trim();
    const limit = query.limit ?? 10;

    if (!aboutLower) {
      return this.entries.slice(0, limit);
    }

    const tokens = aboutLower.split(/\s+/).filter(Boolean);

    const matches = this.entries.filter((entry) => {
      const subject = entry.subject.toLowerCase();
      const predicate = entry.predicate.toLowerCase();
      const object = entry.object.toLowerCase();
      const combined = `${subject} ${predicate} ${object}`;

      // Check if query or any token appears in the triplet
      return (
        combined.includes(aboutLower) ||
        tokens.some((t) => subject.includes(t) || object.includes(t) || predicate.includes(t))
      );
    });

    return matches.slice(0, limit);
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }

  get allEntries(): GraphMemoryEntry[] {
    return [...this.entries];
  }
}

/**
 * Creates a GraphMemoryStore automatically based on environment variables.
 * Returns Neo4jGraphMemoryStore if NEO4J_URI is present, otherwise returns InMemoryGraphMemoryStore.
 */
export async function createAutoGraphMemoryStore(): Promise<GraphMemoryStore> {
  if (process.env.NEO4J_URI) {
    const { Neo4jGraphMemoryStore } = await import("./neo4jGraphMemory.ts");
    return new Neo4jGraphMemoryStore({
      uri: process.env.NEO4J_URI,
      username: process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME ?? "neo4j",
      password: process.env.NEO4J_PASSWORD ?? "",
    });
  }
  return new InMemoryGraphMemoryStore();
}
