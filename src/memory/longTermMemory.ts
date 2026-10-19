import type { LongTermMemoryHook, Message, ModelProvider, TraceExporter } from "../types.ts";
import type { GraphMemoryEntry, GraphMemoryStore } from "./types.ts";
import { effectiveConfidence, factId } from "./facts.ts";
import {
  FactExtractor,
  GraphMaintainer,
  RelationshipBuilder,
  type FactExtractorOptions,
  type GraphEvent,
  type GraphEventListener,
  type GraphMaintainerOptions,
  type RelationshipBuilderOptions,
} from "./graphProcesses.ts";

type ProcessConfig<T> = Omit<T, "store" | "onEvent" | "traceExporter">;

export interface LongTermMemoryOptions {
  store: GraphMemoryStore;
  /** Model used by the fact extractor. */
  model: ModelProvider;
  extractor?: Omit<ProcessConfig<FactExtractorOptions>, "model">;
  relationships?: ProcessConfig<RelationshipBuilderOptions>;
  maintenance?: ProcessConfig<GraphMaintainerOptions>;
  retrieval?: {
    /** Max facts injected into the prompt. Default 8. */
    limit?: number;
    /** Ignore facts whose decayed confidence is below this. Default 0.3. */
    minConfidence?: number;
    /** Entities always looked up, e.g. the speaker. Default ["User"]. */
    alwaysInclude?: string[];
  };
  /** Receives one trace per background process run. */
  traceExporter?: TraceExporter;
}

export interface RetrievedContext {
  facts: GraphMemoryEntry[];
  text: string;
}

const STOPWORDS = new Set(
  "the and for are but not you your yours with this that what which who whom how why when where was were will would can could should have has had does did about from into over than then them they their there here just like also some any all very more most our out its it's i'm i've let me my mine".split(
    " "
  )
);

/**
 * Long-term memory = a graph store + three background processes + retrieval for agents.
 *
 * ```ts
 * const memory = new LongTermMemory({ store, model });
 * memory.start();
 * await agent.run(input, { longTermMemory: memory }); // reads context, queues the conversation
 * await memory.stop();
 * ```
 */
export class LongTermMemory implements LongTermMemoryHook {
  readonly store: GraphMemoryStore;
  readonly extractor: FactExtractor;
  readonly relationshipBuilder: RelationshipBuilder;
  readonly maintainer: GraphMaintainer;
  private listeners = new Set<GraphEventListener>();
  private retrieval: Required<NonNullable<LongTermMemoryOptions["retrieval"]>>;

  constructor(options: LongTermMemoryOptions) {
    this.store = options.store;
    const shared = {
      store: options.store,
      onEvent: (event: GraphEvent) => this.dispatch(event),
      traceExporter: options.traceExporter,
    };
    this.extractor = new FactExtractor({ ...options.extractor, ...shared, model: options.model });
    this.relationshipBuilder = new RelationshipBuilder({ ...options.relationships, ...shared });
    this.maintainer = new GraphMaintainer({ ...options.maintenance, ...shared });
    this.retrieval = {
      limit: options.retrieval?.limit ?? 8,
      minConfidence: options.retrieval?.minConfidence ?? 0.3,
      alwaysInclude: options.retrieval?.alwaysInclude ?? ["User"],
    };
  }

  /** Subscribe to background events. Returns an unsubscribe function. */
  on(listener: GraphEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start all three background processes. */
  start(): void {
    this.extractor.start();
    this.relationshipBuilder.start();
    this.maintainer.start();
  }

  /** Stop all processes, waiting for in-flight runs. Pass `{ flush: true }` to process queued work first. */
  async stop(options: { flush?: boolean } = {}): Promise<void> {
    await Promise.all([this.extractor.stop(), this.relationshipBuilder.stop(), this.maintainer.stop()]);
    if (options.flush) await this.flush();
  }

  /**
   * Run every process once, in order, after draining the extraction queue.
   * Useful in tests, scripts and before shutdown.
   */
  async flush(): Promise<void> {
    let guard = 100;
    while (this.extractor.pending > 0 && guard-- > 0) await this.extractor.runOnce();
    await this.relationshipBuilder.runOnce();
    await this.maintainer.runOnce();
  }

  /** Queue a finished conversation for fact extraction. Non-blocking. */
  ingest(messages: Message[], meta: { sessionId?: string } = {}): void {
    this.extractor.enqueue({ messages, sessionId: meta.sessionId });
  }

  /** Facts relevant to `input`, ranked by time-decayed confidence, plus a prompt-ready text block. */
  async retrieveContext(input: string): Promise<RetrievedContext> {
    const keywords = [
      ...this.retrieval.alwaysInclude.map((k) => k.toLowerCase()),
      ...input
        .toLowerCase()
        .split(/[^\p{L}\p{N}#+.]+/u)
        .map((w) => w.replace(/^\.+|\.+$/g, ""))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ];
    const unique = [...new Set(keywords)];
    if (unique.length === 0) return { facts: [], text: "" };

    // ponytail: substring keyword match, no embeddings; swap recall() for vector search if recall quality matters.
    const candidates = await this.store.recall({ about: unique.join(" "), limit: 200 });
    const now = Date.now();
    const seen = new Set<string>();
    const ranked = candidates
      .filter((f) => !seen.has(factId(f)) && seen.add(factId(f)))
      .map((f) => ({ f, score: effectiveConfidence(f, now, this.maintainer.halfLifeMs) }))
      .filter(({ score }) => score >= this.retrieval.minConfidence)
      .sort((a, b) => b.score - a.score)
      .slice(0, this.retrieval.limit)
      .map(({ f }) => f);

    const text = ranked
      .map((f) => `- ${f.subject} ${f.predicate} ${f.object} (confidence ${(f.confidence ?? 1).toFixed(2)})`)
      .join("\n");
    return { facts: ranked, text };
  }

  private dispatch(event: GraphEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener errors are the listener's problem.
      }
    }
  }
}
