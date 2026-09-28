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
 * A semantic fact representation in the Knowledge Graph.
 */
export interface GraphMemoryEntry {
  subject: string;
  predicate: string;
  object: string;
  metadata?: Record<string, unknown>;
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
   * Store a semantic triplet (subject -> predicate -> object) in long-term memory.
   */
  remember(entry: GraphMemoryEntry): Promise<void>;

  /**
   * Search and recall semantic triplets related to a query topic or entity.
   */
  recall(query: GraphMemoryQuery): Promise<GraphMemoryEntry[]>;

  /**
   * Close any open network connections or database handles.
   */
  close(): Promise<void>;
}
