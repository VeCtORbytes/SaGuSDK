import type { Message } from "../types.ts";

/**
 * Pluggable Session Store interface for raw sequential conversation history.
 */
export interface SessionStore {
  /**
   * Retrieve all messages recorded for the given sessionId in chronological order.
   */
  getHistory(sessionId: string): Promise<Message[]>;

  /**
   * Append one or more messages to the session's history.
   */
  appendMessages(sessionId: string, messages: Message[]): Promise<void>;

  /**
   * Delete all history associated with the given sessionId.
   */
  clear(sessionId: string): Promise<void>;
}

/**
 * A semantic fact in the knowledge graph: (subject) -[predicate]-> (object).
 *
 * Only subject/predicate/object are required. Stores fill in the bookkeeping fields
 * (confidence, mentions, timestamps) so background processes can reinforce, decay and prune facts.
 */
export interface GraphMemoryEntry {
  subject: string;
  predicate: string;
  object: string;
  /** Belief in the fact, 0..1. Stores default it to 1 when omitted. */
  confidence?: number;
  /** How many times the fact was asserted. Maintained by stores. */
  mentions?: number;
  /** Where the fact came from, e.g. "session:abc", "tool:remember_fact", "inferred:rule". */
  source?: string;
  /** Epoch ms when first stored. */
  createdAt?: number;
  /** Epoch ms when last asserted or updated. */
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

/** Identity of a fact: the (subject, predicate, object) triple. */
export interface FactKey {
  subject: string;
  predicate: string;
  object: string;
}

/**
 * Query parameter for recalling facts from Graph Memory.
 */
export interface GraphMemoryQuery {
  about: string;
  limit?: number;
}

/**
 * Interface for semantic long-term graph memory stores.
 */
export interface GraphMemoryStore {
  /**
   * Upsert a fact. If the triple already exists, provided fields overwrite stored ones,
   * `createdAt` is preserved and `mentions` is incremented.
   */
  remember(entry: GraphMemoryEntry): Promise<void>;

  /**
   * Search facts related to a topic or entity.
   */
  recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]>;

  /**
   * Every fact in the graph. Used by background maintenance processes.
   */
  listFacts(): Promise<GraphMemoryEntry[]>;

  /**
   * Delete one fact. Entities left without any facts are removed too.
   */
  forget(key: FactKey): Promise<void>;

  /**
   * Merge entity `from` into entity `into`: every fact mentioning `from` is rewritten to `into`.
   */
  mergeEntities(from: string, into: string): Promise<void>;

  /**
   * Close any open network connections or database handles.
   */
  close(): Promise<void>;
}
