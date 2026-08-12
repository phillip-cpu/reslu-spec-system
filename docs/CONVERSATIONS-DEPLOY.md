# RESLU conversations deployment

Migration `088_staff_conversations.sql` adds the canonical staff/agent conversation model. Migration `091_realtime_voice_consults.sql` adds idempotent Realtime consult turns and precise barge-in cancellation. Migration `092_conversation_attachments.sql` adds private staged photo/PDF records and the atomic message-binding function. Migration `099_persistent_agent_tasks.sql` adds durable background tasks, observable events, reviewable artifacts and explicit approval. Migration `100_openclaw_gateway_progress.sql` adds bounded metadata-only Gateway run and progress fields. Migration `104_single_active_conversation_call.sql` recovers orphaned browser calls and enforces one canonical active call per person across devices. Migration `105_conversation_message_edit_delete.sql` adds conflict-safe edits and private recoverable deletes. Migration `106_conversation_message_reactions_pins.sql` adds member-scoped quick reactions and shared pinned messages. Migration `107_conversation_message_forwarding.sql` adds exactly-once text/private-file forwarding. Apply every relevant migration before deploying its app version.

For migration 099, run `supabase/fixtures/099_persistent_agent_tasks_verify.sql` after the migration. It must report PASS and rolls its test task, event and artifact back. After deployment, pull the same commit on the Mac host and restart the conversation bridge; the task workers live in that bridge and are independent from live call and chat turns. Optional Mac overrides are `RESLU_TASK_FAST_MODEL`, `RESLU_TASK_STANDARD_MODEL` and `RESLU_TASK_STRONG_MODEL`; the strong tier defaults to `openai/gpt-5.6-sol`.

For migration 100, run `supabase/fixtures/100_openclaw_gateway_progress_verify.sql`; it must report PASS and rolls back. Deploy the app before enabling the matching bridge transport. On the Mac, set `RESLU_OPENCLAW_GATEWAY_EVENTS_ENABLED=true` in `.env.local`, pull the same release, and restart the conversation bridge. The helper connects only to `ws://127.0.0.1:18789` by default, reads the existing Gateway token locally, uses the canonical conversation/task session key and sends the database job/task id as the OpenClaw idempotency key. It publishes accepted, lifecycle, safe tool-category and drafting labels; prompts, assistant deltas, tool arguments and tool results are never written as progress. If Gateway connection fails before acceptance it safely falls back to the existing CLI. Once a run is accepted, it never replays through the CLI.

For migration 104, run `supabase/fixtures/104_single_active_conversation_call_verify.sql`; it must report PASS and rolls back. Applying the migration first marks duplicate or more-than-four-hour active rows as dropped, writes a truthful recovery record and cancels only unfinished conversational consult jobs associated with those calls. A new call then atomically supersedes any older active call for that profile. Durable `agent_tasks` are deliberately preserved and continue independently after a call is displaced, interrupted or ended.

For migration 105, run `supabase/fixtures/105_conversation_message_edit_delete_verify.sql`; it must print the PASS notice and roll back. An edit is available to the human author for 15 minutes and uses the message's current `edited_at` or `created_at` version so one device cannot overwrite a newer edit. Delete replaces shared text with a tombstone, keeps the original text in an author-only RLS table for 30 days, hides attachments immediately and cancels only an unfinished conversational reply. Restore never re-enqueues Aria or Marco and never restarts a durable task.

For migration 106, run `supabase/fixtures/106_conversation_message_reactions_pins_verify.sql`; it must print the PASS notice and roll back. Each human member has one current reaction per live message and may change or remove it. Up to five shared message pins are serialized per conversation and remain available above the timeline even when the message is older than the loaded page. Deleting a message clears its reactions and pin in the same transaction.

For migration 107, run `supabase/fixtures/107_conversation_message_forwarding_verify.sql`; it must print the PASS notice and roll back. A forward to 1–10 member conversations is one atomic, device-idempotent request. Text and up to six ready private attachments become independent target messages; storage bytes are not copied and the original unique attachment row is never exposed or duplicated. A direct Aria/Marco destination queues exactly one normal agent turn. Pull and restart the Mac bridge with this release so forwarded private files are materialised for the existing agent runtime just like newly uploaded files.

The web app provides durable chat history, staff and agent group membership, voice transcripts, call records, and a browser audio-first call presentation. Human-to-human text works entirely through Supabase. Aria and Marco replies use their existing OpenClaw runtimes through the Mac mini bridge.

## Mac mini bridge

1. Pull the deployed app repository on the mini.
2. Confirm `.env.local` contains `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Confirm `openclaw agent --agent main` reaches Aria and `openclaw agent --agent marco` reaches Marco. Override either mapping with `RESLU_ARIA_AGENT_ID` or `RESLU_MARCO_AGENT_ID`.
4. Copy `scripts/ai.reslu.conversation-bridge.plist` to `~/Library/LaunchAgents/`, adjusting `/Users/vale/reslu-spec-system` if the checkout lives elsewhere.
5. Bootstrap and inspect it:

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.reslu.conversation-bridge.plist
launchctl kickstart -k gui/$(id -u)/ai.reslu.conversation-bridge
tail -f ~/.openclaw/workspace/vault/agent-openclaw/daily/conversation-bridge.log
```

The bridge polls only the dedicated lightweight agent job table. Each worker reuses one private HTTPS connection to Supabase instead of opening a new TLS handshake for every poll and context lookup. A claimed turn fetches its transport metadata and newest-message files together, then loads recent messages with their author names and ready-file metadata in one joined request. It routes each RESLU conversation through a stable OpenClaw session key, sends the existing runtime the recent canonical thread history, then stores only the final response in that same thread. With migration 100 and its feature flag enabled, the bridge uses the authenticated loopback Gateway event protocol and shows member-scoped progress while keeping the CLI as a pre-acceptance fallback. For a newest message containing uploaded or forwarded attachments, the bridge downloads those private objects into a per-job temporary directory, instructs the existing agent to inspect their local paths, and removes the directory when the synchronous agent turn finishes. A newer spoken turn cancels the exact accepted Gateway run and publication of stale output. Cancellation never claims to reverse an external side effect that already completed.

## Current release boundary

- Durable one-to-one and mixed group text conversations.
- Aria and Marco agent transport through existing runtimes.
- OpenAI Realtime WebRTC audio, semantic VAD, true barge-in, mute, repeat, voice hang-up, and call records when enabled; browser speech remains the disabled-feature fallback.
- Up to six private JPEG, PNG, WebP or PDF attachments per canonical message, 25 MB each; folders and filing to a lead/project remain later phases.
- No WhatsApp dependency.

Aria Meeting Mode’s staged minutes, destination confidence and explicit filing approval should be built next on `conversation_calls.presentation = 'meeting'`; do not publish minutes directly from raw capture.
