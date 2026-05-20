# Deploy

`agent deploy --target <docker|fly|node>` scaffolds a self-contained deploy artifact that **bundles the iii engine alongside your worker**. There's no separate iii infra to provision — `docker run` or `fly deploy` boots both processes inside the same container.

## docker — anywhere a container runs

```bash
cd packages/examples-sre
agent deploy --target docker
```

Generates:

| File | What |
|---|---|
| `Dockerfile` | Multi-stage: installs node deps, downloads the iii binary, copies your code, runs `start.sh`. |
| `scripts/start.sh` | Boots iii in the background, waits for `:3111/health`, then runs the worker. Cleanly tears down on SIGTERM. |
| `DEPLOY.docker.md` | Operator runbook (build/run commands, env vars). |

Then:

```bash
docker build -t sre-triage .
docker run --rm -p 3111:3111 -p 49134:49134 \
  -e OPENAI_API_KEY=$OPENAI_API_KEY \
  sre-triage
```

To push to a registry:

```bash
agent deploy --target docker --build --registry ghcr.io/me
```

## fly — managed deploy

```bash
agent deploy --target fly --app-name sre-triage
fly launch --no-deploy
fly secrets set OPENAI_API_KEY=… SERPAPI_API_KEY=…
fly deploy
```

Generates everything `--target docker` does, plus:

| File | What |
|---|---|
| `fly.toml` | Default config: `iad` region, shared CPU, 1 GB RAM, auto-stop/start. Tweak before first deploy. |

iii's state worker writes to local disk by default. For state durability across machine restarts on Fly, swap `iii-state`'s backend to Redis or Postgres — provision them as fly addons and update `iii-config.yaml` accordingly.

## node — bring your own host

```bash
agent deploy --target node
```

Same `Dockerfile` + `start.sh`, but the operator runbook is written for "I have a VM (EC2, GCE, bare metal) and want to run a container on it." Identical artifacts, different framing.

## What's actually in the image

Three things, one container:

1. The iii engine binary (downloaded from `iii-hq/iii` GitHub releases at build time, pinned to a specific release).
2. Your `node_modules` and source.
3. A tiny `start.sh` that boots iii, waits for it, then `exec`s `agent dev --no-docker --no-iii`.

The worker connects to iii over `ws://localhost:49134` inside the container. From the outside, only `:3111` (iii HTTP) is exposed for triggers.

## Splitting iii from the worker (for scale)

The bundled image is the happy path. For higher load, you'd want:

- A dedicated iii engine (one or more, behind a load balancer or with Redis-backed iii-state for HA).
- N stateless worker containers connected via `III_WS_URL=ws://iii-engine:49134`.

To produce a worker-only image, edit the generated `Dockerfile` and delete the `iii` download step. The worker reads `III_WS_URL` from env and connects out.

## Diff from `agent deploy --build` (the old default)

`--build` without `--target` still works, but it now generates a **bundled** Dockerfile by default (iii + worker) rather than the old worker-only image. If you want the old behavior — worker-only, external iii — generate the `node` target and remove the iii block from the Dockerfile. We didn't add a `--no-bundle` flag because doing so re-encodes the "iii is separate infra" assumption we just removed.

## What `agent deploy --target` doesn't (yet) do

Honest list:

- **Cloudflare Workers.** iii is a Rust binary that doesn't run in the Workers isolate model. We'd need iii's WASM build to land first. Skipped.
- **AWS Lambda.** Same issue — Lambda's container runtime can host the image, but cold-starting iii on every invocation defeats the point. Use ECS/Fargate instead with the `docker` target.
- **Multi-region with shared state.** The bundled image keeps state local. For multi-region, see "Splitting iii from the worker" above.
- **Auto-detection of secrets to set.** `agent deploy --target fly` prints reminders for the keys you'll need but doesn't run `fly secrets set` for you. Felt invasive.
