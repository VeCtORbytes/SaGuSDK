import type { FactKey, GraphMemoryEntry } from "./types.ts";

/** Trim and collapse whitespace. Keeps the original casing for display. */
export function normalizeEntity(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/** Canonical predicate form: UPPER_SNAKE_CASE ("works on" → "WORKS_ON"). */
export function normalizePredicate(predicate: string): string {
  return predicate
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Loose identity for duplicate detection: case, whitespace, "-", "_" and "." are ignored,
 * so "TypeScript", "typescript", "Type Script" and "Node.js"/"NodeJS" match,
 * while "C", "C#" and "C++" stay distinct.
 */
export function entityKey(name: string): string {
  return name.toLowerCase().replace(/[\s\-_.]+/g, "");
}

/** Case-insensitive identity of a stored fact. */
export function factId(key: FactKey): string {
  return [key.subject, key.predicate, key.object].map((p) => p.trim().toLowerCase()).join("\u0000");
}

/** Combine two independent confirmations of the same fact (noisy-OR). */
export function reinforceConfidence(existing: number, incoming: number): number {
  return 1 - (1 - existing) * (1 - incoming);
}

/**
 * Confidence after time decay: halves every `halfLifeMs` since the fact was last asserted.
 * Pass `Infinity` to disable decay.
 */
export function effectiveConfidence(fact: GraphMemoryEntry, now: number, halfLifeMs: number): number {
  const base = fact.confidence ?? 1;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return base;
  const age = Math.max(0, now - (fact.updatedAt ?? now));
  return base * Math.pow(0.5, age / halfLifeMs);
}

export function formatFact(fact: FactKey): string {
  return `${fact.subject} ${fact.predicate} ${fact.object}`;
}
