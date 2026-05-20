import type {
  VectorMemory,
  VectorRecord,
  VectorSearchHit,
  VectorSearchOpts,
} from "@snoopy/core";
import weaviate, {
  type WeaviateClient,
  type Collection,
} from "weaviate-client";

export interface WeaviateMemoryOpts {
  /** Collection (class) name in Weaviate. Created if missing. */
  collection: string;
  /**
   * Connection. One of:
   *   - `client`: a pre-constructed WeaviateClient
   *   - `local`: connect to localhost (default port 8080 + gRPC 50051)
   *   - `cloud`: pass `cloudUrl` + `apiKey`
   */
  client?: WeaviateClient;
  local?: boolean;
  cloudUrl?: string;
  apiKey?: string;
  /**
   * Embeddings provider. If your Weaviate cluster has a vectorizer module
   * configured (text2vec-openai, text2vec-cohere, etc.), leave this
   * undefined and Weaviate will embed server-side. Otherwise pass an
   * Embedder and we'll embed client-side and upsert as `vector`.
   */
  embedder?: (text: string) => Promise<number[]>;
}

/**
 * Weaviate-backed VectorMemory. Auto-creates the collection on first
 * connect with a minimal schema (`text` + `metadata`). Supports either
 * server-side vectorization (when a vectorizer module is configured) or
 * client-side embeddings via the `embedder` option.
 */
export class WeaviateVectorStore<TMeta = Record<string, unknown>>
  implements VectorMemory<TMeta>
{
  private clientPromise: Promise<WeaviateClient>;
  private collection: string;
  private embedder?: (text: string) => Promise<number[]>;

  constructor(opts: WeaviateMemoryOpts) {
    this.collection = opts.collection;
    this.embedder = opts.embedder;
    this.clientPromise = this.connect(opts).then(async (client) => {
      await this.ensureCollection(client);
      return client;
    });
  }

  private async connect(opts: WeaviateMemoryOpts): Promise<WeaviateClient> {
    if (opts.client) return opts.client;
    if (opts.cloudUrl) {
      return weaviate.connectToWeaviateCloud(opts.cloudUrl, {
        authCredentials: opts.apiKey
          ? new weaviate.ApiKey(opts.apiKey)
          : undefined,
      });
    }
    return weaviate.connectToLocal();
  }

  private async ensureCollection(client: WeaviateClient): Promise<void> {
    const exists = await client.collections.exists(this.collection);
    if (exists) return;
    await client.collections.create({
      name: this.collection,
      // No vectorizer specified — caller decides: either provide an
      // embedder (client-side) or pre-configure the Weaviate module.
      properties: [
        { name: "text", dataType: "text" },
        { name: "metadata", dataType: "object", nestedProperties: [] },
      ],
    });
  }

  private async col(): Promise<Collection> {
    const client = await this.clientPromise;
    return client.collections.use(this.collection);
  }

  async upsert(record: VectorRecord<TMeta>): Promise<void> {
    const col = await this.col();
    const vector = this.embedder ? await this.embedder(record.text) : undefined;
    await col.data.insert({
      id: record.id,
      properties: {
        text: record.text,
        metadata: record.metadata ?? {},
      },
      ...(vector ? { vectors: vector } : {}),
    });
  }

  async search(
    query: string,
    opts: VectorSearchOpts<TMeta> = {},
  ): Promise<VectorSearchHit<TMeta>[]> {
    const col = await this.col();
    const limit = opts.k ?? 10;

    const result = this.embedder
      ? await col.query.nearVector(await this.embedder(query), {
          limit,
          returnMetadata: ["score"],
        })
      : await col.query.nearText(query, {
          limit,
          returnMetadata: ["score"],
        });

    const hits: VectorSearchHit<TMeta>[] = [];
    for (const obj of result.objects) {
      const meta = (obj.properties?.metadata ?? {}) as TMeta;
      if (opts.filter && !opts.filter(meta)) continue;
      const score = (obj.metadata as any)?.score ?? 0;
      if (opts.minScore !== undefined && score < opts.minScore) continue;
      hits.push({
        id: String(obj.uuid),
        text: String(obj.properties?.text ?? ""),
        metadata: meta,
        score,
      });
    }
    return hits;
  }

  async delete(id: string): Promise<void> {
    const col = await this.col();
    await col.data.deleteById(id);
  }
}
