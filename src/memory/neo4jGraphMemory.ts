import type { FactKey, GraphMemoryEntry, GraphMemoryQuery, GraphMemoryStore } from "./types.ts";
import { MemoryError } from "../errors.ts";

export interface Neo4jGraphMemoryOptions {
  uri: string;
  /** Defaults to process.env.NEO4J_USER (or NEO4J_USERNAME). */
  username?: string;
  /** Defaults to process.env.NEO4J_PASSWORD. */
  password?: string;
  database?: string;
  driver?: any; // Allow injecting mocked or pre-existing driver in tests
}

/**
 * Production Graph Memory Store backed by Neo4j graph database.
 *
 * Model: (:Entity {name})-[:RELATION {type, confidence, mentions, source, createdAt, updatedAt}]->(:Entity {name})
 */
export class Neo4jGraphMemoryStore implements GraphMemoryStore {
  readonly uri: string;
  readonly database?: string;
  private username?: string;
  private password?: string;
  private driver: any;

  constructor(options: Neo4jGraphMemoryOptions) {
    this.uri = options.uri;
    this.database = options.database;
    this.username = options.username ?? process.env.NEO4J_USER ?? process.env.NEO4J_USERNAME;
    this.password = options.password ?? process.env.NEO4J_PASSWORD;

    if (options.driver) {
      this.driver = options.driver;
    }
  }

  private async getDriver(): Promise<any> {
    if (this.driver) {
      return this.driver;
    }

    try {
      // Dynamic import to keep neo4j-driver optional and prevent load failures when not installed
      const neo4j = await import("neo4j-driver");
      const auth =
        this.username || this.password
          ? neo4j.default.auth.basic(this.username ?? "neo4j", this.password ?? "")
          : undefined;

      this.driver = neo4j.default.driver(this.uri, auth);
      return this.driver;
    } catch (err: any) {
      throw new MemoryError(
        "Neo4jGraphMemoryStore",
        "connect",
        `Failed to initialize neo4j driver: ${err.message}. Ensure 'neo4j-driver' is installed.`
      );
    }
  }

  private async run(operation: string, cypher: string, params: Record<string, unknown>): Promise<any[]> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });
    try {
      const result = await session.run(cypher, params);
      return result.records ?? [];
    } catch (err: any) {
      throw new MemoryError("Neo4jGraphMemoryStore", operation, err.message, { params });
    } finally {
      await session.close();
    }
  }

  async remember(entry: GraphMemoryEntry): Promise<void> {
    await this.run(
      "remember",
      `
        MERGE (s:Entity { name: $subject })
        MERGE (o:Entity { name: $object })
        MERGE (s)-[r:RELATION { type: $predicate }]->(o)
        ON CREATE SET r.createdAt = coalesce($createdAt, timestamp()), r.mentions = 0
        SET r.mentions = r.mentions + 1,
            r.confidence = coalesce($confidence, r.confidence, 1.0),
            r.source = coalesce($source, r.source),
            r.updatedAt = coalesce($updatedAt, timestamp())
      `,
      {
        subject: entry.subject.trim(),
        predicate: entry.predicate.trim(),
        object: entry.object.trim(),
        confidence: entry.confidence ?? null,
        source: entry.source ?? null,
        createdAt: entry.createdAt ?? null,
        updatedAt: entry.updatedAt ?? null,
      }
    );
  }

  async recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]> {
    const about = query.about.trim().toLowerCase();
    const terms = [...new Set([about, ...about.split(/\s+/)].filter(Boolean))];
    const records = await this.run(
      "recall",
      `
        MATCH (s:Entity)-[r:RELATION]->(o:Entity)
        WHERE size($terms) = 0 OR any(t IN $terms WHERE
          toLower(s.name) CONTAINS t OR toLower(o.name) CONTAINS t OR toLower(r.type) CONTAINS t)
        RETURN ${FACT_COLUMNS}
        ORDER BY coalesce(r.confidence, 1.0) DESC
        LIMIT toInteger($limit)
      `,
      { terms, limit: Number(query.limit ?? 10) }
    );
    return records.map(toFact);
  }

  async listFacts(): Promise<GraphMemoryEntry[]> {
    const records = await this.run(
      "listFacts",
      `MATCH (s:Entity)-[r:RELATION]->(o:Entity) RETURN ${FACT_COLUMNS}`,
      {}
    );
    return records.map(toFact);
  }

  async forget(key: FactKey): Promise<void> {
    await this.run(
      "forget",
      `
        MATCH (s:Entity)-[r:RELATION]->(o:Entity)
        WHERE toLower(s.name) = toLower($subject) AND toLower(r.type) = toLower($predicate)
          AND toLower(o.name) = toLower($object)
        DELETE r
        WITH DISTINCT s, o
        UNWIND [s, o] AS e
        WITH DISTINCT e WHERE NOT (e)--()
        DELETE e
      `,
      { subject: key.subject.trim(), predicate: key.predicate.trim(), object: key.object.trim() }
    );
  }

  async mergeEntities(from: string, into: string): Promise<void> {
    const source = from.trim();
    const target = into.trim();
    if (source === target) return;

    // ponytail: several statements, not one transaction; a crash mid-merge leaves both nodes, rerunning finishes it.
    const facts = (await this.listFacts()).filter((f) => f.subject === source || f.object === source);

    for (const fact of facts) {
      const moved = {
        ...fact,
        subject: fact.subject === source ? target : fact.subject,
        object: fact.object === source ? target : fact.object,
      };
      await this.forget(fact);
      if (moved.subject.toLowerCase() === moved.object.toLowerCase()) continue;
      await this.run(
        "mergeEntities",
        `
          MERGE (s:Entity { name: $subject })
          MERGE (o:Entity { name: $object })
          MERGE (s)-[r:RELATION { type: $predicate }]->(o)
          SET r.mentions = coalesce(r.mentions, 0) + $mentions,
              r.confidence = CASE WHEN r.confidence IS NULL OR $confidence > r.confidence THEN $confidence ELSE r.confidence END,
              r.source = coalesce(r.source, $source),
              r.createdAt = CASE WHEN r.createdAt IS NULL OR $createdAt < r.createdAt THEN $createdAt ELSE r.createdAt END,
              r.updatedAt = CASE WHEN r.updatedAt IS NULL OR $updatedAt > r.updatedAt THEN $updatedAt ELSE r.updatedAt END
        `,
        {
          subject: moved.subject,
          predicate: moved.predicate,
          object: moved.object,
          mentions: moved.mentions ?? 1,
          confidence: moved.confidence ?? 1,
          source: moved.source ?? null,
          createdAt: moved.createdAt ?? Date.now(),
          updatedAt: moved.updatedAt ?? Date.now(),
        }
      );
    }

    await this.run(
      "mergeEntities",
      `MATCH (e:Entity { name: $from }) WHERE NOT (e)--() DELETE e`,
      { from: source }
    );
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}

const FACT_COLUMNS = `s.name AS subject, r.type AS predicate, o.name AS object,
  r.confidence AS confidence, r.mentions AS mentions, r.source AS source,
  r.createdAt AS createdAt, r.updatedAt AS updatedAt`;

/** neo4j-driver returns Integer objects for whole numbers. */
function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof (value as any).toNumber === "function") return (value as any).toNumber();
  return Number(value);
}

function toFact(record: any): GraphMemoryEntry {
  const fact: GraphMemoryEntry = {
    subject: record.get("subject"),
    predicate: record.get("predicate"),
    object: record.get("object"),
  };
  const confidence = num(record.get("confidence"));
  const mentions = num(record.get("mentions"));
  const createdAt = num(record.get("createdAt"));
  const updatedAt = num(record.get("updatedAt"));
  const source = record.get("source");
  if (confidence !== undefined) fact.confidence = confidence;
  if (mentions !== undefined) fact.mentions = mentions;
  if (createdAt !== undefined) fact.createdAt = createdAt;
  if (updatedAt !== undefined) fact.updatedAt = updatedAt;
  if (source) fact.source = source;
  return fact;
}
