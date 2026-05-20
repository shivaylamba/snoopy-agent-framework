#!/usr/bin/env bash
# Install the iii ecosystem workers snoopy benefits from.
# Idempotent — `iii worker add` is a no-op when a worker is already installed.
#
# Run after `iii` is installed and the engine has been configured (NOT
# `--use-default-config` — that has no config file to write to).
set -e

IIIBIN="${IIIBIN:-$HOME/.local/bin/iii}"
[ -x "$IIIBIN" ] || { echo "iii binary not found at $IIIBIN — set IIIBIN=…"; exit 1; }

declare -A WORKERS=(
  [iii-state]="distributed KV with reactive change triggers"
  [iii-observability]="OTel traces / metrics / logs / alerts"
  [iii-cron]="schedule functions on cron expressions"
  [iii-queue]="async job processing with retries + DLQ"
  [iii-stream]="durable streams for real-time data"
  [iii-pubsub]="topic-based publish/subscribe"
  [iii-sandbox]="isolated microVM execution (14 sandbox::* triggers)"
  [provider-openai]="OpenAI Chat Completions as iii functions"
  [provider-anthropic]="Anthropic Messages as iii functions"
  [auth-credentials]="credential vault for API keys / OAuth tokens"
)

# Optional / situational — install only when requested
declare -A OPTIONAL=(
  [turn-orchestrator]="agent turn state machine — alternative to snoopy's loop"
  [provider-router]="multi-provider routing + assistant management"
  [models-catalog]="model capabilities knowledge base"
  [approval-gate]="function call approval workflow"
  [policy-denylist]="function call blocking policy"
  [iii-bridge]="connect to another iii instance"
)

echo "Installing core iii ecosystem workers for snoopy:"
echo
for name in "${!WORKERS[@]}"; do
  printf "  %-22s — %s\n" "$name" "${WORKERS[$name]}"
done
echo

read -p "Continue? (y/N) " ans
[[ "$ans" =~ ^[Yy] ]] || exit 0

for name in "${!WORKERS[@]}"; do
  echo
  echo "── iii worker add $name ──"
  "$IIIBIN" worker add "$name" --no-wait || echo "  (continuing despite error on $name)"
done

echo
echo "Installed. Check status:"
echo "  iii worker list"
echo
echo "Optional workers (not installed by default — uncomment in this script to enable):"
for name in "${!OPTIONAL[@]}"; do
  printf "  %-22s — %s\n" "$name" "${OPTIONAL[$name]}"
done
