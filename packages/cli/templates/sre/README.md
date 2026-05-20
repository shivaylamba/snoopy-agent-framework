# SRE agent template

Three agents wired up out of the box: triage (entry), investigator (sub-agent), fixer (sub-agent). Webhook trigger on `/alerts/pagerduty`.

```bash
pnpm install
pnpm dev

# In another shell:
curl -X POST http://localhost:3111/triggers/webhook/alerts/pagerduty \
  -d '{"service":"payments","msg":"5xx spike"}'
```

Edit `agents/triage.ts` to change the entry agent's behavior. Tools live in `tools/`. Skill markdown lives in `.agents/skills/`.
