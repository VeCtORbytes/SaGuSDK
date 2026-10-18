import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TokenUsage, Trace, TraceExporter, TraceSpan } from "./types.ts";
import { redactSecrets } from "./reliability.ts";

export type { TraceSpan, Trace, TraceExporter };

/**
 * In-memory trace recorder that tracks spans, hierarchy, timing, and token usage for an agent run.
 */
export class TraceRecorder {
  readonly runId: string;
  readonly startTime: number;
  private spans: TraceSpan[] = [];
  private activeSpanStack: string[] = [];
  private usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private endTime?: number;

  constructor(runId?: string) {
    this.runId = runId ?? randomUUID();
    this.startTime = Date.now();
  }

  /**
   * Start a new span. If parentId is not specified, uses the current active span on the stack.
   */
  startSpan(
    name: string,
    attributes: Record<string, unknown> = {},
    parentId?: string
  ): string {
    const id = randomUUID();
    const effectiveParentId =
      parentId !== undefined
        ? parentId
        : this.activeSpanStack[this.activeSpanStack.length - 1];

    const span: TraceSpan = {
      id,
      parentId: effectiveParentId,
      name,
      startTime: Date.now(),
      attributes: { ...attributes },
    };

    this.spans.push(span);
    this.activeSpanStack.push(id);
    return id;
  }

  /**
   * Complete an active span with optional attributes or an error.
   */
  endSpan(
    spanId: string,
    attributes?: Record<string, unknown>,
    error?: unknown
  ): void {
    const span = this.spans.find((s) => s.id === spanId);
    if (span) {
      span.endTime = Date.now();
      if (attributes) {
        Object.assign(span.attributes, attributes);
      }
      if (error) {
        if (error instanceof Error) {
          span.error = {
            name: error.name,
            message: error.message,
            stack: error.stack,
          };
        } else {
          span.error = { message: String(error) };
        }
      }
    }

    // Remove from active stack if it matches top or within
    const stackIdx = this.activeSpanStack.lastIndexOf(spanId);
    if (stackIdx !== -1) {
      this.activeSpanStack.splice(stackIdx, 1);
    }
  }

  /**
   * Accumulate token usage from a model call.
   */
  recordUsage(usage?: Partial<TokenUsage>): void {
    if (usage) {
      this.usage.promptTokens += usage.promptTokens ?? 0;
      this.usage.completionTokens += usage.completionTokens ?? 0;
      this.usage.totalTokens += usage.totalTokens ?? 0;
    }
  }

  /**
   * Mark the trace as finished.
   */
  finish(): void {
    if (!this.endTime) {
      this.endTime = Date.now();
    }
    // Auto-close any unclosed spans
    for (const span of this.spans) {
      if (!span.endTime) {
        span.endTime = this.endTime;
      }
    }
  }

  /**
   * Returns the completed, sanitized trace with all secrets redacted.
   */
  getTrace(): Trace {
    const rawTrace: Trace = {
      runId: this.runId,
      spans: this.spans,
      usage: { ...this.usage },
      startTime: this.startTime,
      endTime: this.endTime ?? Date.now(),
    };

    return redactSecrets(rawTrace) as Trace;
  }
}

/**
 * Console exporter that formats and prints the trace hierarchy to stdout.
 */
export class ConsoleExporter implements TraceExporter {
  private formatMs(durationMs: number): string {
    return `${durationMs}ms`;
  }

  export(trace: Trace): void {
    const totalDuration = (trace.endTime ?? Date.now()) - trace.startTime;
    console.log(
      `\n┌─ [SAGU TRACE] Run ID: ${trace.runId} (${this.formatMs(totalDuration)})`
    );
    console.log(
      `│  Usage: ${trace.usage.totalTokens} tokens (${trace.usage.promptTokens} in / ${trace.usage.completionTokens} out)`
    );

    // Group spans by parentId to render hierarchy tree
    const childMap = new Map<string | undefined, TraceSpan[]>();
    for (const span of trace.spans) {
      const list = childMap.get(span.parentId) ?? [];
      list.push(span);
      childMap.set(span.parentId, list);
    }

    const printBranch = (parentId: string | undefined, prefix: string) => {
      const children = childMap.get(parentId) ?? [];
      for (let i = 0; i < children.length; i++) {
        const span = children[i]!;
        const isLast = i === children.length - 1;
        const branchSymbol = isLast ? "└─" : "├─";
        const nextPrefix = prefix + (isLast ? "   " : "│  ");
        const duration = (span.endTime ?? Date.now()) - span.startTime;
        const status = span.error ? `❌ [FAILED: ${span.error.message}]` : "✔";

        console.log(
          `${prefix}${branchSymbol} ${span.name} (${this.formatMs(duration)}) ${status}`
        );

        if (Object.keys(span.attributes).length > 0) {
          const attrStr = JSON.stringify(span.attributes);
          console.log(`${nextPrefix}   Attrs: ${attrStr.slice(0, 120)}${attrStr.length > 120 ? "..." : ""}`);
        }

        printBranch(span.id, nextPrefix);
      }
    };

    printBranch(undefined, "│  ");
    console.log(`└─────────────────────────────────────────────────────────\n`);
  }
}

export interface JSONFileExporterOptions {
  /** Explicit destination file path. */
  filePath?: string;
  /** Directory to store traces if filePath is omitted. Defaults to './traces'. */
  outputDir?: string;
}

/**
 * File exporter that writes traces as formatted JSON files.
 */
export class JSONFileExporter implements TraceExporter {
  readonly outputDir: string;
  readonly filePath?: string;

  constructor(options: JSONFileExporterOptions = {}) {
    this.filePath = options.filePath;
    this.outputDir = options.outputDir ?? "./traces";
  }

  async export(trace: Trace): Promise<void> {
    const destination =
      this.filePath ?? join(this.outputDir, `trace-${trace.runId}.json`);

    const dir = this.filePath ? join(this.filePath, "..") : this.outputDir;
    await mkdir(dir, { recursive: true });

    const content = JSON.stringify(trace, null, 2);
    await writeFile(destination, content, "utf-8");
  }
}
