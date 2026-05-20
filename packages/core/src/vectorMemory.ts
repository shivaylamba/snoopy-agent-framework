/**
 * VectorMemory — semantic-search-capable memory backend.
 *
 * Phase 3 deliverable. Two implementations ship in-tree:
 *
 *   - `InMemoryVectorStore` (this file) — zero-config dev backend using
 *     character-trigram cosine. Quality is "lexical-similarity good
 *     enough for tests"; do not use in production for paraphrased query
 *     matching.
 *   - `WeaviateVectorStore` (in `@snoopy/memory-weaviate`) — real vector
 *     DB with proper embeddings and HNSW search.
 *
 * Both implement the same `VectorMemory` interface so user agents can
 * swap them without touching call sites.
 */

export type Embedder = (text: string) => Promise<number[]>;

export interface VectorRecord<TMeta = Record<string, unknown>> {
  id: string;
  text: string;
  metadata?: TMeta;
}

export interface VectorSearchHit<TMeta = Record<string, unknown>>
  extends VectorRecord<TMeta> {
  /** Cosine similarity in [0, 1]. Higher = more similar. */
  score: number;
}

export interface VectorSearchOpts<TMeta = Record<string, unknown>> {
  /** Max results. Default 10. */
  k?: number;
  /** Optional metadata filter applied after the ANN scan. */
  filter?: (m: TMeta | undefined) => boolean;
  /** Minimum cosine score; results below this are dropped. */
  minScore?: number;
}

export interface VectorMemory<TMeta = Record<string, unknown>> {
  upsert(record: VectorRecord<TMeta>): Promise<void>;
  search(query: string, opts?: VectorSearchOpts<TMeta>): Promise<VectorSearchHit<TMeta>[]>;
  delete(id: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryVectorStore — character-trigram cosine fallback
// ─────────────────────────────────────────────────────────────────────────────

interface StoredEntry<TMeta> {
  record: VectorRecord<TMeta>;
  /** Sparse trigram vector represented as a Map of trigram → tf weight. */
  vec: Map<string, number>;
  /** Cached L2 norm. */
  norm: number;
}

/**
 * Character-trigram TF cosine similarity. Good enough for "did we see a
 * paraphrase of this within the last hour?" — not good enough for semantic
 * retrieval over long-tail knowledge. For that, use WeaviateVectorStore.
 */
export class InMemoryVectorStore<TMeta = Record<string, unknown>>
  implements VectorMemory<TMeta>
{
  private entries = new Map<string, StoredEntry<TMeta>>();

  async upsert(record: VectorRecord<TMeta>): Promise<void> {
    const vec = trigramVector(record.text);
    const norm = l2Norm(vec);
    this.entries.set(record.id, { record, vec, norm });
  }

  async search(
    query: string,
    opts: VectorSearchOpts<TMeta> = {},
  ): Promise<VectorSearchHit<TMeta>[]> {
    const qvec = trigramVector(query);
    const qnorm = l2Norm(qvec);
    if (qnorm === 0) return [];

    const hits: VectorSearchHit<TMeta>[] = [];
    for (const { record, vec, norm } of this.entries.values()) {
      if (norm === 0) continue;
      if (opts.filter && !opts.filter(record.metadata)) continue;
      const score = cosine(qvec, qnorm, vec, norm);
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      hits.push({ ...record, score });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, opts.k ?? 10);
  }

  async delete(id: string): Promise<void> {
    this.entries.delete(id);
  }
}

function trigramVector(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
  if (norm.length < 3) {
    // Fall back to whole-string bag if too short for trigrams.
    out.set(norm, 1);
    return out;
  }
  for (let i = 0; i <= norm.length - 3; i++) {
    const g = norm.slice(i, i + 3);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

function l2Norm(v: Map<string, number>): number {
  let sum = 0;
  for (const x of v.values()) sum += x * x;
  return Math.sqrt(sum);
}

function cosine(
  a: Map<string, number>,
  aNorm: number,
  b: Map<string, number>,
  bNorm: number,
): number {
  // Iterate the smaller map for efficiency.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, av] of small) {
    const bv = large.get(k);
    if (bv !== undefined) dot += av * bv;
  }
  return dot / (aNorm * bNorm);
}
