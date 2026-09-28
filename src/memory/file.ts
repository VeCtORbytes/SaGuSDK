import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { Message } from "../types.ts";
import type { SessionStore } from "./types.ts";
import { MemoryError } from "../errors.ts";

export interface FileSessionOptions {
  /**
   * Directory where session JSON files will be stored.
   * Defaults to './.sagu_sessions'.
   */
  storageDir?: string;
}

/**
 * File-backed session store persisting conversation history as JSON files.
 */
export class FileSession implements SessionStore {
  readonly storageDir: string;

  constructor(options: FileSessionOptions = {}) {
    this.storageDir = options.storageDir ?? "./.sagu_sessions";
  }

  private getFilePath(sessionId: string): string {
    const sanitized = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.storageDir, `${sanitized}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.storageDir)) {
      await mkdir(this.storageDir, { recursive: true });
    }
  }

  async getHistory(sessionId: string): Promise<Message[]> {
    try {
      const filePath = this.getFilePath(sessionId);
      if (!existsSync(filePath)) {
        return [];
      }
      const raw = await readFile(filePath, "utf-8");
      return JSON.parse(raw) as Message[];
    } catch (err: any) {
      throw new MemoryError("FileSession", "getHistory", err.message, { sessionId });
    }
  }

  async appendMessages(sessionId: string, messages: Message[]): Promise<void> {
    if (!messages || messages.length === 0) return;

    try {
      await this.ensureDir();
      const current = await this.getHistory(sessionId);
      current.push(...messages);
      const filePath = this.getFilePath(sessionId);
      await writeFile(filePath, JSON.stringify(current, null, 2), "utf-8");
    } catch (err: any) {
      throw new MemoryError("FileSession", "appendMessages", err.message, { sessionId });
    }
  }

  async clear(sessionId: string): Promise<void> {
    try {
      const filePath = this.getFilePath(sessionId);
      if (existsSync(filePath)) {
        await unlink(filePath);
      }
    } catch (err: any) {
      throw new MemoryError("FileSession", "clear", err.message, { sessionId });
    }
  }
}
