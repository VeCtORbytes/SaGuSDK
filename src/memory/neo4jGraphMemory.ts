import type { GraphMemoryEntry, GraphMemoryQuery, GraphMemoryStore } from "./types.ts";
import { MemoryError } from "../errors.ts";

export interface Neo4jGraphMemoryOptions {
  uri: string;
  username?: string;
  password?: string;
  database?: string;
  driver?: any; // Allow injecting mocked or pre-existing driver in tests
}

/**
 * Production Graph Memory Store backed by Neo4j graph database.
 * Connects via neo4j-driver and stores semantic relationships as nodes & edges.
 */
export class Neo4jGraphMemoryStore implements GraphMemoryStore {
  readonly uri: string;
  readonly database?: string;
  private driver: any;

  constructor(options: Neo4jGraphMemoryOptions) {
    this.uri = options.uri;
    this.database = options.database;

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
        process.env.NEO4J_PASSWORD || process.env.NEO4J_USER
          ? neo4j.default.auth.basic(
              process.env.NEO4J_USER ?? "neo4j",
              process.env.NEO4J_PASSWORD ?? ""
            )
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

  async remember(entry: GraphMemoryEntry): Promise<void> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });

    try {
      const cypher = `
        MERGE (s:Entity { name: $subject })
        MERGE (o:Entity { name: $object })
        MERGE (s)-[r:RELATION { type: $predicate }]->(o)
        SET r.updatedAt = timestamp()
      `;

      await session.run(cypher, {
        subject: entry.subject.trim(),
        predicate: entry.predicate.trim(),
        object: entry.object.trim(),
      });
    } catch (err: any) {
      throw new MemoryError("Neo4jGraphMemoryStore", "remember", err.message, { entry });
    } finally {
      await session.close();
    }
  }

  async recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.database });
    const limit = query.limit ?? 10;
    const about = query.about.trim();

    try {
      const cypher = `
        MATCH (s:Entity)-[r:RELATION]->(o:Entity)
        WHERE toLower(s.name) CONTAINS toLower($about)
           OR toLower(o.name) CONTAINS toLower($about)
           OR toLower(r.type) CONTAINS toLower($about)
        RETURN s.name AS subject, r.type AS predicate, o.name AS object
        LIMIT $limit
      `;

      const result = await session.run(cypher, {
        about,
        limit: Number(limit),
      });

      return result.records.map((record: any) => ({
        subject: record.get("subject"),
        predicate: record.get("predicate"),
        object: record.get("object"),
      }));
    } catch (err: any) {
      throw new MemoryError("Neo4jGraphMemoryStore", "recall", err.message, { query });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}
