import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Agent } from "../agent.ts";
import { isTransientError, withRetry } from "../reliability.ts";
import { TraceRecorder } from "../trace.ts";
import type { Message, ModelProvider, TraceExporter } from "../types.ts";
import type { FactKey, GraphMemoryEntry, GraphMemoryStore } from "./types.ts";
import {
  effectiveConfidence,
  entityKey,
  factId,
  normalizeEntity,
  normalizePredicate,
  reinforceConfidence,
} from "./facts.ts";

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export type GraphProcessName = "fact_extractor" | "relationship_builder" | "graph_maintainer";

/** One change a background process made to the graph. */
export type GraphUpdate =
  | { operation: "fact_added" | "fact_reinforced"; fact: GraphMemoryEntry }
  | { operation: "relationship_inferred" | "relationship_updated"; fact: GraphMemoryEntry; rule: string }
  | { operation: "entities_merged"; from: string; into: string }
  | { operation: "conflict_resolved"; kept: GraphMemoryEntry; removed: GraphMemoryEntry }
  | { operation: "fact_pruned"; fact: GraphMemoryEntry; reason: "stale" | "low_confidence"; effectiveConfidence: number };

/** Events emitted by background graph processes (outside any agent run). */
export type GraphEvent =
  | ({ type: "graph_updated"; process: GraphProcessName } & GraphUpdate)
  | { type: "process_completed"; process: GraphProcessName; changes: number; durationMs: number; traceId: string }
  | { type: "process_failed"; process: GraphProcessName; error: unknown; attempt: number; willRetry: boolean };

export type GraphEventListener = (event: GraphEvent) => void;

/* -------------------------------------------------------------------------- */
/* Shared worker base                                                         */
/* -------------------------------------------------------------------------- */

export interface GraphProcessOptions {
  store: GraphMemoryStore;
  /** Delay between background runs. */
  intervalMs?: number;
  /** Retries per run for transient errors (network, 429, 5xx). Default 2. */
  maxRetries?: number;
  onEvent?: GraphEventListener;
  traceExporter?: TraceExporter;
}

export interface ProcessContext {
  trace: TraceRecorder;
  /** Record a change: emits `graph_updated` and adds a trace span. */
  record(update: GraphUpdate): void;
}

/**
 * Runs `work()` on a timer, independent of any agent run.
 * - While started, the process keeps Node alive (like a DB pool); call `stop()` to let it exit.
 * - Runs never overlap; `runOnce()` while a run is in flight returns that run.
 * - Transient failures are retried; anything else emits `process_failed` and the loop keeps going.
 */
export abstract class GraphProcess {
  abstract readonly name: GraphProcessName;
  readonly store: GraphMemoryStore;
  readonly intervalMs: number;
  private maxRetries: number;
  private onEvent?: GraphEventListener;
  private traceExporter?: TraceExporter;
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<number>;
  private running = false;

  constructor(options: GraphProcessOptions, defaultIntervalMs: number) {
    this.store = options.store;
    this.intervalMs = options.intervalMs ?? defaultIntervalMs;
    this.maxRetries = options.maxRetries ?? 2;
    this.onEvent = options.onEvent;
    this.traceExporter = options.traceExporter;
  }

  /** Do one pass. Return the number of graph changes made. */
  protected abstract work(ctx: ProcessContext): Promise<number>;

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.intervalMs);
  }

  /** Stop the timer and wait for an in-flight run to finish. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  /** Run one pass now. Never throws; failures are reported as `process_failed` events. */
  runOnce(): Promise<number> {
    this.inFlight ??= this.execute().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Run as soon as possible (used when new work arrives). */
  protected kick(): void {
    if (this.running) this.schedule(0);
  }

  protected emit(event: GraphEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A throwing listener must not break the process loop.
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      await this.runOnce();
      if (this.running && !this.timer) this.schedule(this.intervalMs);
    }, delayMs);
  }

  private async execute(): Promise<number> {
    const trace = new TraceRecorder(`${this.name}:${randomUUID()}`);
    const rootSpan = trace.startSpan("graph_process", { process: this.name });
    const started = Date.now();
    const ctx: ProcessContext = {
      trace,
      record: (update) => {
        const span = trace.startSpan("graph_update", { process: this.name, ...describe(update) });
        trace.endSpan(span);
        this.emit({ type: "graph_updated", process: this.name, ...update } as GraphEvent);
      },
    };

    let changes = 0;
    let failure: unknown;
    try {
      changes = await withRetry(() => this.work(ctx), {
        maxRetries: this.maxRetries,
        shouldRetry: isTransientError,
        onRetry: (error, attempt) =>
          this.emit({ type: "process_failed", process: this.name, error, attempt, willRetry: true }),
      });
      this.emit({
        type: "process_completed",
        process: this.name,
        changes,
        durationMs: Date.now() - started,
        traceId: trace.runId,
      });
    } catch (error) {
      failure = error;
      this.emit({ type: "process_failed", process: this.name, error, attempt: this.maxRetries + 1, willRetry: false });
    }

    trace.endSpan(rootSpan, { changes }, failure);
    trace.finish();
    if (this.traceExporter) {
      try {
        await this.traceExporter.export(trace.getTrace());
      } catch {
        // Exporter failures never affect graph processing.
      }
    }
    return changes;
  }
}

function describe(update: GraphUpdate): Record<string, unknown> {
  switch (update.operation) {
    case "entities_merged":
      return { operation: update.operation, from: update.from, into: update.into };
    case "conflict_resolved":
      return { operation: update.operation, kept: fmt(update.kept), removed: fmt(update.removed) };
    default:
      return { operation: update.operation, fact: fmt(update.fact) };
  }
}

function fmt(f: FactKey): string {
  return `${f.subject} -[${f.predicate}]-> ${f.object}`;
}

/* -------------------------------------------------------------------------- */
/* Process 1: Fact extraction                                                 */
/* -------------------------------------------------------------------------- */

export interface ConversationInput {
  messages: Message[];
  sessionId?: string;
}

export interface FactExtractorOptions extends GraphProcessOptions {
  /** Model used to read conversations and propose facts. */
  model: ModelProvider;
  /** Facts below this confidence are discarded. Default 0.5. */
  minConfidence?: number;
  /** Conversations handled per run. Default 5. */
  batchSize?: number;
  /** Attempts per conversation before it is dropped. Default 3. */
  maxAttempts?: number;
  /** Replace the default extraction instructions. */
  instructions?: string;
}

const ExtractionSchema = z.object({
  facts: z.array(
    z.object({
      subject: z.string().describe("Entity the fact is about. Use 'User' for the person talking to the assistant."),
      predicate: z.string().describe("Relationship in UPPER_SNAKE_CASE, e.g. WORKS_ON, USES, PREFERS, LIVES_IN, KNOWS"),
      object: z.string().describe("Target entity or value"),
      confidence: z.number().min(0).max(1).describe("How certain the conversation makes this fact, 0..1"),
    })
  ),
});

const DEFAULT_EXTRACTION_INSTRUCTIONS = `You extract durable long-term memory from conversations.
Return facts as (subject, predicate, object) triples about people, projects, organizations, technologies, preferences and relationships.
Rules:
- Only facts likely to stay true beyond this conversation. Skip greetings, questions and one-off requests.
- Refer to the human speaker as "User".
- Predicates are short UPPER_SNAKE_CASE verbs: WORKS_ON, WORKS_AT, USES, PREFERS, LIVES_IN, KNOWS, MEMBER_OF, PART_OF, HAS_ROLE.
- Reuse an existing entity name from the list below when it refers to the same thing.
- confidence: 0.9+ when stated directly, ~0.6 when implied.
- Return {"facts": []} when there is nothing worth remembering.`;

/**
 * Process 1 — reads queued conversations and writes facts to the graph.
 * New facts are added; repeated facts are reinforced (confidence combined, mentions incremented).
 */
export class FactExtractor extends GraphProcess {
  readonly name = "fact_extractor" as const;
  private queue: (ConversationInput & { attempts: number })[] = [];
  private minConfidence: number;
  private batchSize: number;
  private maxAttempts: number;
  private agent: Agent<z.infer<typeof ExtractionSchema>>;

  constructor(options: FactExtractorOptions) {
    super(options, 5_000);
    this.minConfidence = options.minConfidence ?? 0.5;
    this.batchSize = options.batchSize ?? 5;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.agent = new Agent({
      name: "FactExtractor",
      instructions: options.instructions ?? DEFAULT_EXTRACTION_INSTRUCTIONS,
      model: options.model,
      outputSchema: ExtractionSchema,
      maxTurns: 4,
      maxRepairAttempts: 2,
      temperature: 0,
    });
  }

  /** Conversations waiting to be processed. */
  get pending(): number {
    return this.queue.length;
  }

  /** Queue a conversation. Returns immediately; extraction happens in the background. */
  enqueue(input: ConversationInput): void {
    if (!input.messages.some((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())) return;
    this.queue.push({ ...input, attempts: 0 });
    this.kick();
  }

  protected async work(ctx: ProcessContext): Promise<number> {
    const batch = this.queue.splice(0, this.batchSize);
    if (batch.length === 0) return 0;

    let changes = 0;
    for (const item of batch) {
      const span = ctx.trace.startSpan("extract_conversation", { sessionId: item.sessionId, attempt: item.attempts + 1 });
      try {
        changes += await this.extract(item, ctx);
        ctx.trace.endSpan(span);
      } catch (error) {
        ctx.trace.endSpan(span, undefined, error);
        item.attempts++;
        const willRetry = item.attempts < this.maxAttempts;
        if (willRetry) this.queue.push(item);
        this.emit({ type: "process_failed", process: this.name, error, attempt: item.attempts, willRetry });
      }
    }
    // More fresh work: go again now. Retries wait for the next interval instead of spinning.
    if (this.queue.some((i) => i.attempts === 0)) this.kick();
    return changes;
  }

  private async extract(item: ConversationInput, ctx: ProcessContext): Promise<number> {
    const existing = await this.store.listFacts();
    const known = new Map(existing.map((f) => [factId(f), f]));
    const entities = [...new Set(existing.flatMap((f) => [f.subject, f.object]))].slice(0, 100);

    const transcript = item.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.content.trim())
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const result = await this.agent.run(
      `Known entities: ${entities.length ? entities.join(", ") : "(none yet)"}\n\nConversation:\n${transcript}`
    );
    if (!result.success) throw result.error;

    let changes = 0;
    for (const raw of result.output.facts) {
      const subject = normalizeEntity(raw.subject);
      const predicate = normalizePredicate(raw.predicate);
      const object = normalizeEntity(raw.object);
      if (!subject || !predicate || !object) continue;
      if (entityKey(subject) === entityKey(object)) continue; // self-loop: meaningless
      if (raw.confidence < this.minConfidence) continue;

      const previous = known.get(factId({ subject, predicate, object }));
      const fact: GraphMemoryEntry = {
        subject,
        predicate,
        object,
        confidence: previous ? reinforceConfidence(previous.confidence ?? 1, raw.confidence) : raw.confidence,
        source: item.sessionId ? `session:${item.sessionId}` : "conversation",
      };
      await this.store.remember(fact);
      known.set(factId(fact), { ...previous, ...fact });
      ctx.record({ operation: previous ? "fact_reinforced" : "fact_added", fact });
      changes++;
    }
    return changes;
  }
}

/* -------------------------------------------------------------------------- */
/* Process 2: Relationship building                                           */
/* -------------------------------------------------------------------------- */

/** A -[when[0]]-> B -[when[1]]-> C  ⇒  A -[then]-> C */
export interface InferenceRule {
  name: string;
  when: [string, string];
  then: string;
}

export const DEFAULT_INFERENCE_RULES: InferenceRule[] = [
  { name: "works_on_uses", when: ["WORKS_ON", "USES"], then: "USES" },
  { name: "member_of_works_on", when: ["MEMBER_OF", "WORKS_ON"], then: "WORKS_ON" },
  { name: "part_of_transitive", when: ["PART_OF", "PART_OF"], then: "PART_OF" },
];

export const DEFAULT_SYMMETRIC_PREDICATES = ["KNOWS", "FRIEND_OF", "COLLEAGUE_OF", "MARRIED_TO", "SIBLING_OF", "RELATED_TO"];

export interface RelationshipBuilderOptions extends GraphProcessOptions {
  rules?: InferenceRule[];
  /** Predicates that hold in both directions; the reverse edge is added. */
  symmetricPredicates?: string[];
  /** Inferred facts below this confidence are not created. Default 0.5. */
  minConfidence?: number;
}

/**
 * Process 2 — derives new relationships from existing facts:
 * symmetric predicates get their reverse edge, and chain rules add A→C from A→B→C.
 * Inferred confidence is the product of its premises; its timestamp is the newest premise's,
 * so inferred facts age with the facts they came from. Duplicates and self-loops are never created.
 */
export class RelationshipBuilder extends GraphProcess {
  readonly name = "relationship_builder" as const;
  private rules: InferenceRule[];
  private symmetric: Set<string>;
  private minConfidence: number;

  constructor(options: RelationshipBuilderOptions) {
    super(options, 30_000);
    this.rules = (options.rules ?? DEFAULT_INFERENCE_RULES).map((r) => ({
      ...r,
      when: [normalizePredicate(r.when[0]), normalizePredicate(r.when[1])],
      then: normalizePredicate(r.then),
    }));
    this.symmetric = new Set((options.symmetricPredicates ?? DEFAULT_SYMMETRIC_PREDICATES).map(normalizePredicate));
    this.minConfidence = options.minConfidence ?? 0.5;
  }

  protected async work(ctx: ProcessContext): Promise<number> {
    const facts = await this.store.listFacts();
    const byId = new Map(facts.map((f) => [looseId(f), f]));
    const candidates = new Map<string, { fact: GraphMemoryEntry; rule: string }>();

    const propose = (fact: GraphMemoryEntry, rule: string) => {
      if (entityKey(fact.subject) === entityKey(fact.object)) return;
      if ((fact.confidence ?? 1) < this.minConfidence) return;
      const id = looseId(fact);
      const best = candidates.get(id);
      if (!best || (fact.confidence ?? 1) > (best.fact.confidence ?? 1)) candidates.set(id, { fact, rule });
    };

    for (const f of facts) {
      if (this.symmetric.has(normalizePredicate(f.predicate))) {
        propose({ subject: f.object, predicate: f.predicate, object: f.subject, confidence: f.confidence ?? 1, updatedAt: f.updatedAt }, "symmetric");
      }
    }

    for (const rule of this.rules) {
      const first = facts.filter((f) => normalizePredicate(f.predicate) === rule.when[0]);
      const second = facts.filter((f) => normalizePredicate(f.predicate) === rule.when[1]);
      for (const a of first) {
        for (const b of second) {
          if (entityKey(a.object) !== entityKey(b.subject)) continue;
          propose(
            {
              subject: a.subject,
              predicate: rule.then,
              object: b.object,
              confidence: (a.confidence ?? 1) * (b.confidence ?? 1),
              updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0) || undefined,
            },
            rule.name
          );
        }
      }
    }

    let changes = 0;
    for (const [id, { fact, rule }] of candidates) {
      const existing = byId.get(id);
      const source = `inferred:${rule}`;
      if (existing) {
        // Only refresh facts we inferred ourselves; never overwrite stated facts.
        if (!existing.source?.startsWith("inferred:")) continue;
        const fresher = (fact.updatedAt ?? 0) > (existing.updatedAt ?? 0);
        const changedConfidence = Math.abs((fact.confidence ?? 1) - (existing.confidence ?? 1)) > 1e-6;
        if (!fresher && !changedConfidence) continue;
        const updated = { ...existing, confidence: fact.confidence, updatedAt: fact.updatedAt, source };
        await this.store.remember(updated);
        ctx.record({ operation: "relationship_updated", fact: updated, rule });
      } else {
        const created = { ...fact, source };
        await this.store.remember(created);
        ctx.record({ operation: "relationship_inferred", fact: created, rule });
      }
      changes++;
    }
    return changes;
  }
}

/** Identity tolerant of spacing/case/punctuation differences, so near-duplicates aren't inferred. */
function looseId(f: FactKey): string {
  return `${entityKey(f.subject)}\u0000${normalizePredicate(f.predicate)}\u0000${entityKey(f.object)}`;
}

/* -------------------------------------------------------------------------- */
/* Process 3: Graph maintenance                                               */
/* -------------------------------------------------------------------------- */

export const DEFAULT_SINGLE_VALUED_PREDICATES = ["LIVES_IN", "WORKS_AT", "HAS_ROLE", "HAS_TITLE", "REPORTS_TO", "AGE"];

export interface GraphMaintainerOptions extends GraphProcessOptions {
  /** Confidence halves every `halfLifeMs` without re-assertion. Default 30 days. `Infinity` disables decay. */
  halfLifeMs?: number;
  /** Facts whose decayed confidence falls below this are pruned. Default 0.2. */
  pruneBelow?: number;
  /** Predicates that can have only one current value per subject; older values are removed. */
  singleValuedPredicates?: string[];
}

/**
 * Process 3 — keeps the graph clean:
 * 1. merges duplicate entities ("TypeScript" / "typescript" / "Type Script"),
 * 2. resolves conflicts on single-valued predicates (newest value wins),
 * 3. prunes facts whose time-decayed confidence is too low.
 */
export class GraphMaintainer extends GraphProcess {
  readonly name = "graph_maintainer" as const;
  readonly halfLifeMs: number;
  private pruneBelow: number;
  private singleValued: Set<string>;

  constructor(options: GraphMaintainerOptions) {
    super(options, 60_000);
    this.halfLifeMs = options.halfLifeMs ?? 30 * 24 * 60 * 60 * 1000;
    this.pruneBelow = options.pruneBelow ?? 0.2;
    this.singleValued = new Set((options.singleValuedPredicates ?? DEFAULT_SINGLE_VALUED_PREDICATES).map(normalizePredicate));
  }

  protected async work(ctx: ProcessContext): Promise<number> {
    let changes = 0;
    changes += await this.mergeDuplicates(ctx);
    changes += await this.resolveConflicts(ctx);
    changes += await this.prune(ctx);
    return changes;
  }

  private async mergeDuplicates(ctx: ProcessContext): Promise<number> {
    const facts = await this.store.listFacts();
    const usage = new Map<string, number>();
    for (const f of facts) {
      usage.set(f.subject, (usage.get(f.subject) ?? 0) + 1);
      usage.set(f.object, (usage.get(f.object) ?? 0) + 1);
    }

    const groups = new Map<string, string[]>();
    for (const name of usage.keys()) {
      const key = entityKey(name);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }

    let changes = 0;
    for (const names of groups.values()) {
      if (names.length < 2) continue;
      // Canonical name: most used, then the one with more capitals ("TypeScript" over "typescript"), then alphabetical.
      const [canonical, ...duplicates] = [...names].sort(
        (a, b) =>
          (usage.get(b) ?? 0) - (usage.get(a) ?? 0) ||
          capitals(b) - capitals(a) ||
          a.localeCompare(b)
      );
      for (const dup of duplicates) {
        await this.store.mergeEntities(dup, canonical!);
        ctx.record({ operation: "entities_merged", from: dup, into: canonical! });
        changes++;
      }
    }
    return changes;
  }

  private async resolveConflicts(ctx: ProcessContext): Promise<number> {
    const facts = await this.store.listFacts();
    const groups = new Map<string, GraphMemoryEntry[]>();
    for (const f of facts) {
      const predicate = normalizePredicate(f.predicate);
      if (!this.singleValued.has(predicate)) continue;
      const key = `${entityKey(f.subject)}\u0000${predicate}`;
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }

    let changes = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [kept, ...older] = [...group].sort(
        (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || (b.confidence ?? 1) - (a.confidence ?? 1)
      );
      for (const removed of older) {
        await this.store.forget(removed);
        ctx.record({ operation: "conflict_resolved", kept: kept!, removed });
        changes++;
      }
    }
    return changes;
  }

  private async prune(ctx: ProcessContext): Promise<number> {
    const now = Date.now();
    let changes = 0;
    for (const fact of await this.store.listFacts()) {
      const effective = effectiveConfidence(fact, now, this.halfLifeMs);
      if (effective >= this.pruneBelow) continue;
      await this.store.forget(fact);
      ctx.record({
        operation: "fact_pruned",
        fact,
        reason: (fact.confidence ?? 1) >= this.pruneBelow ? "stale" : "low_confidence",
        effectiveConfidence: effective,
      });
      changes++;
    }
    return changes;
  }
}

function capitals(s: string): number {
  return (s.match(/\p{Lu}/gu) ?? []).length;
}

