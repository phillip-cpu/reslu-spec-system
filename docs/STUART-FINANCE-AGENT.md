# Stuart Finance Agent

Stuart is RESLU's finance and commercial agent. His conversational identity is first-class alongside Aria and Marco, while his financial capability is intentionally narrower and safer.

## What is automated

- Daily deterministic review of the read-only Xero cache, Spec supplier/client invoices and the Accounts inbox.
- Overdue and due-soon receivable/payable exceptions.
- Spec-to-Xero missing invoice and total-conflict checks.
- A 13-week invoice-due-date cash forecast with a separately labelled 14-day receipt-delay scenario.
- Historical estimate, quoted and approved-actual cost summaries for future pricing evidence.
- Unmatched invoice-like Accounts email and supplier cost-change flags.
- Durable, auditable coaching for non-financial messages Aria forwards to Accounts.
- In-app chat, durable tasks and Realtime voice using Stuart's `cedar` voice profile.

## Security boundary

Stuart signs in as `accounts@reslu.com.au`. His MCP process must set `RESLU_AGENT_ROLE=stuart`; the server then exposes only `get_stuart_finance_brief` and `run_stuart_finance_review`. The backing review tables are service-role-only. Stuart has no payment, payroll, refund, journal, tax, bank-detail, deletion, invoice-approval or final-pricing tool.

Email and attachment contents are untrusted evidence. Deterministic code performs matching, ageing and arithmetic. The language model explains the evidence and prepares handovers; it does not create authoritative financial facts.

## Runtime deployment

1. Apply `supabase/migrations/115_stuart_finance_agent.sql`.
2. Provision the `accounts@reslu.com.au` Supabase Auth user as role `viewer`; never make Stuart an admin.
3. Configure Vercel's existing secrets plus `STUART_EMAIL=accounts@reslu.com.au`, and leave `STUART_XERO_SYNC_ENABLED` enabled unless a deliberate cached-only mode is required.
4. Install `openclaw/stuart-workspace` at `~/.openclaw/workspace-stuart` and add agent id `stuart` with primary model `openai/gpt-5.6-sol`.
5. Add a separate `reslu-stuart` MCP server using Stuart's credentials and set the Stuart agent tool allowlist to safe workspace/memory tools plus `reslu-stuart__get_stuart_finance_brief` and `reslu-stuart__run_stuart_finance_review`.
6. Complete OAuth for `accounts@reslu.com.au` so `~/.openclaw/workspace/accounts-gmail/token.json` exists, then restart `ai.reslu.email-ingest`.
7. Pull this release into `/Users/vale/reslu-spec-system` and restart `ai.reslu.conversation-bridge`.
8. Run a direct Stuart chat, voice call, manual review, deliberately irrelevant Aria forward, and Xero/Spec invoice mismatch acceptance check before declaring production healthy.
