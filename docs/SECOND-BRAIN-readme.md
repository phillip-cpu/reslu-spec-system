# RESLU Second Brain — Handoff Package

8 Jul 2026 · prepared by Claude Fable 5 for Phillip / Aria

## Contents

| File | What it is |
|---|---|
| `RESLU-second-brain-build-brief.md` | The build spec. 13 self-contained steps with SQL, tool signatures and acceptance criteria. This is the document that gets executed. |
| `brain-visualizer-reference.html` | Approved visualizer design, working code. Open it in a browser to see it run. Ships to the repo alongside the brief for Step 13. |
| `research-notes.md` | Evidence behind every design decision, with primary-source links. Background reading, not a work order. |

## How to run the build

1. Commit all three files to the spec system repo under `docs/`.
2. Do Step 0 (manual prerequisites) yourself — 5 minutes.
3. For each step 1–13: open a FRESH Claude Code session on **Sonnet**, paste the brief's Global Conventions section + that one step. Plan mode first for steps 5, 9, 10, 11. Stop when the step's acceptance criteria pass. `/clear`, next step.
4. Steps 9–11 (email pipeline) are the bulk of the work — treat each as its own session, don't merge them.
5. Step 13 (visualizer) is optional and engineering-only: the reference HTML is the frozen design; Sonnet wires data, never restyles. Visual changes require screenshots + Phillip's sign-off.

## Non-negotiables baked into the brief

- Prices and lead times NEVER write directly — always proposals, Phillip approves.
- Every extracted value carries a `source_quote` that must string-match the source text (deterministic gate, catches hallucination from any model).
- Ollama does enum classification and nothing generative. Embeddings are OpenAI text-embedding-3-small from Vercel (MCP lives on Vercel; local Ollama is unreachable from there and query/index embeddings must share a model).
- Idle heartbeats cost zero tokens — scripts poll, models get woken only when there's work.

## Estimates

Build: 15–30M tokens total across sessions (within Max plan limits over 1–2 weeks). Running cost once live: ~$10–12/month at ~50 emails/day.
