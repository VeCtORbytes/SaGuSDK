import type { Message } from "../types.ts";
import type { SessionStore } from "./types.ts";

export interface InMemorySessionOptions {
  /**
   * Maximum number of messages to retain per session (oldest messages pruned first).
   */
  maxMessagesPerSession?: number;
}

/**
 * In-Memory session store for holding conversation histories during development and testing.
 */
export class InMemorySession implements SessionStore {
  private sessions = new Map<string, Message[]>();
  private maxMessages?: number;

  constructor(options: InMemorySessionOptions = {}) {
    this.maxMessages = options.maxMessagesPerSession;
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    const list = this.sessions.get(sessionId);
    return list ? [...list] : [];
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;

    const current = this.sessions.get(sessionId) ?? [];
    current.push(...messages);

    if (this.maxMessages && current.length > this.maxMessages) {
      current.splice(0, current.length - this.maxMessages);
    }

    this.sessions.set(sessionId, current);
  }

  async clear(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  async clearAll(): Promise<void> {
    this.sessions.clear();
  }
}
