import type { TriggerDef } from "./types.js";

export interface TriggerAuthConfig {
  /** Bearer token auth. The trigger handler checks `Authorization: Bearer <secret>`. */
  type: "bearer";
  /** Env var holding the shared secret. Required for verification at deploy time. */
  secretEnv: string;
}

export interface HttpTriggerOpts {
  path: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Bearer-token auth — production triggers should set this. */
  auth?: TriggerAuthConfig;
}

export interface CronTriggerOpts {
  /** Standard cron expression, e.g. "*\/5 * * * *" */
  schedule: string;
  timezone?: string;
}

export interface WebhookTriggerOpts {
  path: string;
  /** Optional shared-secret header for verification. */
  secretHeader?: string;
  /** Bearer-token auth — production webhooks should set this. */
  auth?: TriggerAuthConfig;
}

export interface QueueTriggerOpts {
  queue: string;
  concurrency?: number;
}

export interface EventTriggerOpts {
  /** Event name to subscribe to, e.g. "triage.completed". */
  event: string;
  /** Optional filter expression evaluated against the event payload. */
  filter?: string;
}

export interface StreamTriggerOpts {
  /** Stream channel ref, e.g. "events:alerts". */
  channel: string;
  /** Subscribe to a particular event type within the channel. */
  event?: "join" | "leave" | "message";
}

export interface StateTriggerOpts {
  /** State key prefix to watch for changes. */
  key: string;
}

export interface SubscribeTriggerOpts {
  /** Pub/sub topic name. */
  topic: string;
}

export interface LogTriggerOpts {
  /** Substring or regex pattern in log messages. */
  pattern: string;
  /** Optional log level filter. */
  level?: "info" | "warn" | "error";
}

export interface DirectTriggerOpts {
  /** No config — registers an HTTP-callable function with no event trigger. */
}

/**
 * Typed builders over iii's 10 trigger types.
 */
export const defineTrigger = {
  http(opts: HttpTriggerOpts): TriggerDef {
    const config: Record<string, unknown> = {
      api_path: opts.path,
      http_method: opts.method ?? "POST",
    };
    if (opts.auth) config.auth = opts.auth;
    return { type: "http", config };
  },

  cron(opts: CronTriggerOpts): TriggerDef {
    return {
      type: "cron",
      config: { schedule: opts.schedule, timezone: opts.timezone },
    };
  },

  webhook(opts: WebhookTriggerOpts): TriggerDef {
    const config: Record<string, unknown> = {
      api_path: opts.path,
      secret_header: opts.secretHeader,
    };
    if (opts.auth) config.auth = opts.auth;
    return { type: "webhook", config };
  },

  queue(opts: QueueTriggerOpts): TriggerDef {
    return {
      type: "queue",
      config: { queue: opts.queue, concurrency: opts.concurrency ?? 1 },
    };
  },

  event(opts: EventTriggerOpts): TriggerDef {
    return {
      type: "event",
      config: { event: opts.event, filter: opts.filter },
    };
  },

  stream(opts: StreamTriggerOpts): TriggerDef {
    return {
      type: "stream",
      config: { channel: opts.channel, event: opts.event ?? "message" },
    };
  },

  state(opts: StateTriggerOpts): TriggerDef {
    return {
      type: "state",
      config: { key: opts.key },
    };
  },

  subscribe(opts: SubscribeTriggerOpts): TriggerDef {
    return {
      type: "subscribe",
      config: { topic: opts.topic },
    };
  },

  log(opts: LogTriggerOpts): TriggerDef {
    return {
      type: "log",
      config: { pattern: opts.pattern, level: opts.level },
    };
  },

  direct(_opts: DirectTriggerOpts = {}): TriggerDef {
    return {
      type: "direct",
      config: {},
    };
  },
};
