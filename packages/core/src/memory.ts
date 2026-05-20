import { createRequire } from "node:module";
import { iiiClient } from "./iiiClient.js";
import { StateKV } from "./stateKv.js";
import { withKeyedLock } from "./keyedMutex.js";

const nodeRequire = createRequire(import.meta.url);

export interface StreamEntry<T = unknown> {
  /** Stream-specific id (Redis "1234-0", in-memory monotonic counter). */
  id: string;
  value: T;
}

export interface Memory {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, val: T, ttlSec?: number): Promise<void>;
  delete(key: string): Promise<void>;
  append(stream: string, event: unknown): Promise<string>;
  /**
   * Read existing entries from `from` (default: beginning) up to now.
   * Use for replay. For live tail, use `tail()`.
   */
  range(stream: string, from?: string): AsyncIterable<StreamEntry>;
  /**
   * Live tail. Yields existing entries from `from` (default: latest)
   * and then blocks (Redis BLOCK) or polls (in-memory) for new ones.
   * Never returns; the caller should iterate until they're done.
   */
  tail(stream: string, from?: string): AsyncIterable<StreamEntry>;
}

// ─────────────────────────────────────────────────────────────────────────────
// InMemoryStore
// ─────────────────────────────────────────────────────────────────────────────

export class InMemoryStore implements Memory {
  private kv = new Map<string, { value: unknown; expiresAt?: number }>();
  private streams = new Map<string, StreamEntry[]>();
  private seq = 0;
  private waiters = new Map<string, Array<() => void>>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.kv.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.kv.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, val: T, ttlSec?: number): Promise<void> {
    this.kv.set(key, {
      value: val,
      expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : undefined,
    });
  }

  async delete(key: string): Promise<void> {
    this.kv.delete(key);
  }

  async append(stream: string, event: unknown): Promise<string> {
    const id = `${Date.now()}-${this.seq++}`;
    const arr = this.streams.get(stream) ?? [];
    arr.push({ id, value: event });
    this.streams.set(stream, arr);
    // Wake any waiters tailing this stream.
    const waiters = this.waiters.get(stream);
    if (waiters?.length) {
      for (const w of waiters) w();
      this.waiters.set(stream, []);
    }
    return id;
  }

  async *range(stream: string, from?: string): AsyncIterable<StreamEntry> {
    const arr = this.streams.get(stream) ?? [];
    for (const entry of arr) {
      if (!from || entry.id > from) yield entry;
    }
  }

  async *tail(stream: string, from?: string): AsyncIterable<StreamEntry> {
    let cursor = from;
    while (true) {
      const arr = this.streams.get(stream) ?? [];
      let yielded = false;
      for (const entry of arr) {
        if (!cursor || entry.id > cursor) {
          cursor = entry.id;
          yielded = true;
          yield entry;
        }
      }
      if (!yielded) {
        await new Promise<void>((resolve) => {
          const list = this.waiters.get(stream) ?? [];
          list.push(resolve);
          this.waiters.set(stream, list);
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// IIIStore — KV + streams via iii primitives. No Redis dependency.
//
// This is the default backend for the framework. Operators only need to
// run iii; everything else (sessions, dedupe, trace history) flows through
// iii's built-in state and stream modules.
// ─────────────────────────────────────────────────────────────────────────────

export class IIIStore implements Memory {
  private readonly kv: StateKV;
  constructor(private readonly scope: string = "snoopy") {
    this.kv = new StateKV(iiiClient());
  }

  async get<T>(key: string): Promise<T | undefined> {
    const v = await this.kv.get<{ v: T; expiresAt?: number } | T | null>(this.scope, key);
    if (v === null || v === undefined) return undefined;
    if (typeof v === "object" && v !== null && "v" in (v as object)) {
      const env = v as { v: T; expiresAt?: number };
      if (env.expiresAt && env.expiresAt < Date.now()) {
        // Serialize the lazy-delete behind a keyed lock to avoid two
        // readers racing to delete the same expired key.
        await withKeyedLock(`expire:${this.scope}:${key}`, () =>
          this.kv.delete(this.scope, key).catch(() => {}),
        );
        return undefined;
      }
      return env.v;
    }
    return v as T;
  }

  async set<T>(key: string, val: T, ttlSec?: number): Promise<void> {
    const envelope = ttlSec
      ? { v: val, expiresAt: Date.now() + ttlSec * 1000 }
      : { v: val };
    await this.kv.set(this.scope, key, envelope);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(this.scope, key);
  }

  async append(stream: string, event: unknown): Promise<string> {
    const iii = iiiClient();
    const id = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    await iii.trigger({
      function_id: "stream::set",
      payload: {
        stream_name: `${this.scope}.${stream}`,
        group_id: "default",
        item_id: id,
        data: event as any,
      },
    });
    return id;
  }

  async *range(stream: string, _from?: string): AsyncIterable<StreamEntry> {
    const iii = iiiClient();
    let list: any;
    try {
      list = await iii.trigger<unknown, any>({
        function_id: "stream::list",
        payload: {
          stream_name: `${this.scope}.${stream}`,
          group_id: "default",
        },
      });
    } catch (e: any) {
      // Empty / unknown stream → no entries
      const msg = String(e?.message ?? e);
      if (/not.*found|does not exist|no.*stream/i.test(msg)) return;
      throw e;
    }
    const items: any[] = Array.isArray(list)
      ? list
      : Array.isArray(list?.items)
        ? list.items
        : [];
    for (const item of items) {
      yield {
        id: String(item.id ?? item.item_id ?? ""),
        value: item.data ?? item.value ?? item,
      };
    }
  }

  async *tail(stream: string, from?: string): AsyncIterable<StreamEntry> {
    let cursor = from;
    while (true) {
      let yielded = false;
      for await (const entry of this.range(stream)) {
        if (!cursor || entry.id > cursor) {
          cursor = entry.id;
          yielded = true;
          yield entry;
        }
      }
      if (!yielded) await new Promise((r) => setTimeout(r, 500));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RedisStore — alternative backend for users who prefer Redis directly
// ─────────────────────────────────────────────────────────────────────────────

export class RedisStore implements Memory {
  private client: any;
  private prefix: string;

  constructor(opts: { url?: string; prefix?: string } = {}) {
    this.prefix = opts.prefix ?? "snoopy:";
    const Redis = nodeRequire("ioredis");
    const Ctor = Redis.default ?? Redis;
    this.client = new Ctor(
      opts.url ?? process.env.REDIS_URL ?? "redis://localhost:6379",
    );
  }

  private k(key: string): string {
    return this.prefix + key;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.k(key));
    if (raw == null) return undefined;
    return JSON.parse(raw) as T;
  }

  async set<T>(key: string, val: T, ttlSec?: number): Promise<void> {
    const raw = JSON.stringify(val);
    if (ttlSec) {
      await this.client.set(this.k(key), raw, "EX", ttlSec);
    } else {
      await this.client.set(this.k(key), raw);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.k(key));
  }

  async append(stream: string, event: unknown): Promise<string> {
    const id: string = await this.client.xadd(
      this.k(`stream:${stream}`),
      "*",
      "v",
      JSON.stringify(event),
    );
    return id;
  }

  async *range(stream: string, from = "-"): AsyncIterable<StreamEntry> {
    const entries: [string, string[]][] = await this.client.xrange(
      this.k(`stream:${stream}`),
      from,
      "+",
    );
    for (const [id, fields] of entries) {
      const v = parseFields(fields);
      if (v !== undefined) yield { id, value: v };
    }
  }

  async *tail(stream: string, from?: string): AsyncIterable<StreamEntry> {
    // XREAD with BLOCK 0 = wait forever for new entries. Start cursor is
    // either the caller's `from`, or `$` (latest only) by default.
    let cursor = from ?? "$";
    while (true) {
      const res: [string, [string, string[]][]][] | null =
        await this.client.xread("BLOCK", 0, "STREAMS", this.k(`stream:${stream}`), cursor);
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          cursor = id;
          const v = parseFields(fields);
          if (v !== undefined) yield { id, value: v };
        }
      }
    }
  }
}

function parseFields(fields: string[]): unknown | undefined {
  const vIdx = fields.indexOf("v");
  if (vIdx < 0 || fields[vIdx + 1] == null) return undefined;
  try {
    return JSON.parse(fields[vIdx + 1]!);
  } catch {
    return fields[vIdx + 1];
  }
}
