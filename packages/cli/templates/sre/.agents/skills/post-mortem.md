# Post-mortem Skill

Shared playbook for investigator and fixer agents. Both are spawned in the wake of a triage decision and have the parent's run id in their input payload.

## Common conventions

- Read incident state from `incident:<parentRunId>:timeline` (use ctx.memory.range).
- Write new findings back to the same stream — never overwrite history.
- Reference specific commit SHAs, pod names, and metric values. Vague summaries are not useful for a post-mortem.

## Investigator-specific

Goal: produce a list of concrete findings and suspect commits. Output a structured result; the parent agent (or the human reading the trace) decides next steps.

## Fixer-specific

Goal: propose the smallest viable patch. The diff goes in your structured result — Phase 1 does NOT auto-apply. A human reviews and lands it.

Confidence calibration:
- `>= 0.8`: you'd land this yourself if you were oncall.
- `0.5–0.8`: needs review but worth showing to oncall.
- `< 0.5`: don't bother emitting; flag for human investigation instead.
