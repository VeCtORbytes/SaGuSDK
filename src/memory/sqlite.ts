import { DatabaseSync } from "node:sqlite";
import type { Message, ToolCall, ToolResult } from "../types.ts";
import type { SessionStore } from "./types.ts";
import { MemoryError } from "../errors.ts";

export interface SqliteSessionOptions {
  /**
   * Database path or ':memory:' for in-memory SQLite database.
   * Defaults to ':memory:'.
   */
  filename?: string;
}

/**
 * Zero-dependency SQLite session store leveraging Node 25's built-in node:sqlite module.
 */
export class SqliteSession implements SessionStore {
  readonly filename: string;
  private db: DatabaseSync;

  constructor(options: SqliteSessionOptions = {}) {
    this.filename = options.filename ?? ":memory:";
    try {
      this.db = new DatabaseSync(this.filename);
      this.initSchema();
    } catch (err: any) {
      throw new MemoryError("SqliteSession", "constructor", err.message, { filename: this.filename });
    }
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sagu_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        tool_calls TEXT,
        tool_result TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sagu_messages_session ON sagu_messages(session_id);
    `);
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    try {
      const stmt = this.db.prepare(
        "SELECT role, content, name, tool_calls, tool_result, metadata FROM sagu_messages WHERE session_id = ? ORDER BY id ASC"
      );
      const rows = stmt.all(sessionId) as Array<{
        role: string;
        content: string;
        name?: string;
        tool_calls?: string;
        tool_result?: string;
        metadata?: string;
      }>;

      return rows.map((row) => {
        const msg: Message = {
          role: row.role as any,
          content: row.content,
        };
        if (row.name) msg.name = row.name;
        if (row.tool_calls) {
          try {
            msg.toolCalls = JSON.parse(row.tool_calls) as ToolCall[];
          } catch {
            // ignore malformed
          }
        }
        if (row.tool_result) {
          try {
            msg.toolResult = JSON.parse(row.tool_result) as ToolResult;
          } catch {
            // ignore malformed
          }
        }
        if (row.metadata) {
          try {
            msg.metadata = JSON.parse(row.metadata);
          } catch {
            // ignore malformed
          }
        }
        return msg;
      });
    } catch (err: any) {
      throw new MemoryError("SqliteSession", "getHistory", err.message, { sessionId });
    }
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO sagu_messages (session_id, role, content, name, tool_calls, tool_result, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = Date.now();
      for (const msg of messages) {
        stmt.run(
          sessionId,
          msg.role,
          msg.content,
          msg.name ?? null,
          msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          msg.toolResult ? JSON.stringify(msg.toolResult) : null,
          msg.metadata ? JSON.stringify(msg.metadata) : null,
          now
        );
      }
    } catch (err: any) {
      throw new MemoryError("SqliteSession", "appendMessages", err.message, { sessionId });
    }
  }

  async clear(sessionId: string): Promise<void> {
    try {
      const stmt = this.db.prepare("DELETE FROM sagu_messages WHERE session_id = ?");
      stmt.run(sessionId);
    } catch (err: any) {
      throw new MemoryError("SqliteSession", "clear", err.message, { sessionId });
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }
}
