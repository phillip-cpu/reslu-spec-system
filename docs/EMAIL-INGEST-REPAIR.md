# Three-mailbox Second Brain ingest

`scripts/email_ingest.py` is the only scheduled RESLU email-ingest worker.
The older `email-ingest.mjs` found in Aria's local workspace is not part of
this repository and must remain unscheduled; do not run both workers.

## Mailboxes and OAuth

The worker reads the existing OAuth files under
`~/.openclaw/workspace` by default:

| Mailbox | Token file |
|---|---|
| `aria@reslu.com.au` | `aria-gmail/token.json` |
| `phillip@reslu.com.au` | `phillip-gmail/token.json` |
| `tenille@reslu.com.au` | `tenille-gmail/token.json` |

The shared OAuth client is `gmail/credentials.json`. These are file paths,
not secrets copied into `.env.local`. Optional path overrides are documented
in `.env.local.example`. Each refreshed token is checked against Gmail's
profile endpoint before mail is read, preventing an account file from being
silently assigned to the wrong person.

The default query is:

```text
newer_than:2d -in:spam -in:trash -in:drafts
```

This captures received, archived and sent mail. Gmail labels determine
`emails.direction`; outbound mail is indexed for history but remains excluded
from automated triage and proposals.

## Safety and deduplication

- RFC Message-ID remains the canonical email dedupe key across mailboxes.
- `emails.ingested_mailboxes` records every mailbox in which a message was
  observed; `gmail_refs` stores the corresponding Gmail identifiers.
- Attachments receive a SHA-256 fingerprint. Original and forwarded emails
  remain in the history, but an identical invoice PDF produces one
  `invoice_candidate` queue key.
- The invoice endpoint's existing unique supplier/project/invoice-number guard
  remains the final financial duplicate protection.
- Transactional automated mail (invoice, receipt, statement, remittance,
  order/payment confirmation or a business-document attachment) is retained.
  Bounces, out-of-office replies, ordinary no-reply notifications and
  newsletters remain skipped.
- Email content can only create approval-gated proposals. It never approves
  invoices or writes project financial actuals.

Migration `059_three_mailbox_email_ingest.sql` must be applied before the new
worker runs.

## Mac-mini validation and cutover

From `/Users/vale/reslu-spec-system` after pulling the deployed commit:

```bash
.venv-email-ingest/bin/python scripts/email_ingest.py --selftest
.venv-email-ingest/bin/python scripts/email_ingest.py --dry-run --limit 20 --verbose
```

The dry run must report `mailboxes_ok=3/3`, `auth_error=0`, and exit `0`.
It writes nothing.

Install the tracked plist only after that passes:

```bash
launchctl bootout gui/$(id -u)/ai.reslu.email-ingest
cp scripts/ai.reslu.email-ingest.plist ~/Library/LaunchAgents/
plutil -lint ~/Library/LaunchAgents/ai.reslu.email-ingest.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.reslu.email-ingest.plist
launchctl kickstart -p gui/$(id -u)/ai.reslu.email-ingest
```

An initial `bootout` "service not found" response is harmless; continue with
the copy/bootstrap steps.

Confirm the installed service points to `scripts/email_ingest.py` and that no
launchd/cron job points to `email-ingest.mjs`.

## Recovery and controlled backfill

Recover the known Goldsworthy Bunnings invoice first:

```bash
.venv-email-ingest/bin/python scripts/email_ingest.py \
  --mailbox phillip@reslu.com.au \
  --query 'from:donotreply@orders.bunnings.com.au subject:"Bunnings Online Order - Invoice" after:2026/07/07 before:2026/07/10' \
  --limit 20 --verbose
```

Verify invoice `99886501` now has one `emails.id`, one attachment hash and one
invoice-candidate queue item. It must remain a proposal awaiting Phillip's
approval.

Then run the agreed 30-day history backfill in bounded mailbox passes:

```bash
.venv-email-ingest/bin/python scripts/email_ingest.py --mailbox aria@reslu.com.au --lookback-days 30 --limit 500
.venv-email-ingest/bin/python scripts/email_ingest.py --mailbox phillip@reslu.com.au --lookback-days 30 --limit 500
.venv-email-ingest/bin/python scripts/email_ingest.py --mailbox tenille@reslu.com.au --lookback-days 30 --limit 500
```

Re-running any command is safe. Existing Message-IDs are merged/deduplicated,
not reprocessed.
