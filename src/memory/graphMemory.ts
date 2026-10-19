import type { FactKey, GraphMemoryEntry, GraphMemoryQuery, GraphMemoryStore } from "./types.ts";
import { factId } from "./facts.ts";

/**
 * In-memory Graph Memory store.
 * Implements the full GraphMemoryStore interface with zero external dependencies.
 * Facts live in process memory only and are lost on restart.
 */
export class InMemoryGraphMemoryStore implements GraphMemoryStore {
  private facts = new Map<string, GraphMemoryEntry>();

  async remember(entry: GraphMemoryEntry): Promise<void> {
    const subject = entry.subject.trim();
    const predicate = entry.predicate.trim();
    const object = entry.object.trim();
    const id = factId({ subject, predicate, object });
    const existing = this.facts.get(id);
    const now = Date.now();

    this.facts.set(id, {
      ...existing,
      subject,
      predicate,
      object,
      confidence: entry.confidence ?? existing?.confidence ?? 1,
      mentions: (existing?.mentions ?? 0) + 1,
      source: entry.source ?? existing?.source,
      createdAt: existing?.createdAt ?? entry.createdAt ?? now,
      updatedAt: entry.updatedAt ?? now,
      metadata: entry.metadata ? { ...entry.metadata } : existing?.metadata,
    });
  }

  async recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]> {
    const aboutLower = query.about.toLowerCase().trim();
    const limit = query.limit ?? 10;
    const all = [...this.facts.values()];

    if (!aboutLower) {
      return all.slice(0, limit).map(copy);
    }

    const tokens = aboutLower.split(/\s+/).filter(Boolean);

    const matches = all.filter((entry) => {
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

    return matches.slice(0, limit).map(copy);
  }

  async listFacts(): Promise<GraphMemoryEntry[]> {
    return [...this.facts.values()].map(copy);
  }

  async forget(key: FactKey): Promise<void> {
    this.facts.delete(factId(key));
  }

  /** Renames the exact entity name `from` to `into` across all facts. */
  async mergeEntities(from: string, into: string): Promise<void> {
    const source = from.trim();
    const target = into.trim();
    if (source === target) return;

    for (const [id, fact] of [...this.facts]) {
      const subjectHit = fact.subject === source;
      const objectHit = fact.object === source;
      if (!subjectHit && !objectHit) continue;

      this.facts.delete(id);
      const moved: GraphMemoryEntry = {
        ...fact,
        subject: subjectHit ? target : fact.subject,
        object: objectHit ? target : fact.object,
      };
      if (moved.subject.toLowerCase() === moved.object.toLowerCase()) continue; // merging made a self-loop

      const existing = this.facts.get(factId(moved));
      this.facts.set(
        factId(moved),
        existing
          ? {
              ...existing,
              confidence: Math.max(existing.confidence ?? 1, moved.confidence ?? 1),
              mentions: (existing.mentions ?? 1) + (moved.mentions ?? 1),
              createdAt: Math.min(existing.createdAt ?? Infinity, moved.createdAt ?? Infinity),
              updatedAt: Math.max(existing.updatedAt ?? 0, moved.updatedAt ?? 0),
            }
          : moved
      );
    }
  }

  async close(): Promise<void> {
    // No-op for in-memory store
  }

  get allEntries(): GraphMemoryEntry[] {
    return [...this.facts.values()].map(copy);
  }
}

function copy(entry: GraphMemoryEntry): GraphMemoryEntry {
  return { ...entry, metadata: entry.metadata ? { ...entry.metadata } : undefined };
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
