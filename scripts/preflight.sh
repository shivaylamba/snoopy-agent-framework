#!/usr/bin/env bash
# Verify your local environment is ready to run snoopy end-to-end.
# Exit 0 = all green; non-zero = something to fix.

set -u

PASS=0
FAIL=0
WARN=0

ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ! $1"; WARN=$((WARN+1)); }
header() { echo; echo "── $1 ──"; }

header "binaries"
command -v node    >/dev/null && ok "node ($(node --version))"    || bad "node not found (need >=20)"
command -v pnpm    >/dev/null && ok "pnpm ($(pnpm --version))"   || bad "pnpm not found (need >=8)"
command -v docker  >/dev/null && ok "docker"                     || bad "docker not found"
command -v python3 >/dev/null && ok "python3 ($(python3 --version 2>&1 | awk '{print $2}'))" \
                              || warn "python3 not found (only needed for Python SDK)"
command -v iii     >/dev/null && ok "iii engine ($(iii --version 2>&1 | head -1))" \
                              || bad "iii not installed — run: curl -fsSL https://iii.dev/install.sh | sh"

header "api keys"
if [ -n "${OPENAI_API_KEY:-}" ]; then ok "OPENAI_API_KEY set"
elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then ok "ANTHROPIC_API_KEY set (will need to override agent model)"
else bad "no LLM API key (set OPENAI_API_KEY or ANTHROPIC_API_KEY)"
fi

header "infrastructure"
if docker compose ps --format json 2>/dev/null | grep -q '"redis"'; then ok "redis container running"
else warn "redis not running — start with: docker compose up -d"
fi
if docker compose ps --format json 2>/dev/null | grep -q '"postgres"'; then ok "postgres container running"
else warn "postgres not running — start with: docker compose up -d"
fi

if curl -fsS http://localhost:6379 -o /dev/null --max-time 1 2>/dev/null; then :; fi
if redis-cli -h localhost ping >/dev/null 2>&1; then ok "redis responds to PING"; fi
if docker exec rohit-redis-1 redis-cli ping 2>/dev/null | grep -q PONG; then ok "redis (in-container) responds"; fi

if docker exec rohit-postgres-1 pg_isready -U snoopy 2>/dev/null | grep -q "accepting"; then ok "postgres accepts connections"; fi

# Check iii engine WebSocket
if command -v nc >/dev/null && nc -z localhost 49134 >/dev/null 2>&1; then ok "iii engine reachable on :49134"
else warn "iii engine not reachable on :49134 — start with: iii --config config.yaml"
fi

header "snoopy build"
if [ -f packages/core/dist/index.js ]; then ok "@snoopy/core built"
else warn "@snoopy/core not built — run: pnpm install && pnpm build"
fi
if [ -f packages/cli/dist/bin.js ]; then ok "@snoopy/cli built"
else warn "@snoopy/cli not built — run: pnpm install && pnpm build"
fi

echo
echo "── result ──"
echo "  $PASS pass · $WARN warn · $FAIL fail"

if [ $FAIL -gt 0 ]; then
  echo
  echo "fix the ✗ items above before running end-to-end."
  exit 1
fi
if [ $WARN -gt 0 ]; then
  echo
  echo "warnings are non-blocking — your env is ready for partial tests."
fi
exit 0
