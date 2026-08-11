# RESLU conversations deployment

Migration `088_staff_conversations.sql` adds the canonical staff/agent conversation model. Migration `091_realtime_voice_consults.sql` adds idempotent Realtime consult turns and precise barge-in cancellation. Migration `092_conversation_attachments.sql` adds private staged photo/PDF records and the atomic message-binding function. Migration `099_persistent_agent_tasks.sql` adds durable background tasks, observable events, reviewable artifacts and explicit approval. Apply every relevant migration before deploying its app version.

For migration 099, run `supabase/fixtures/099_persistent_agent_tasks_verify.sql` after the migration. It must report PASS and rolls its test task, event and artifact back. After deployment, pull the same commit on the Mac host and restart the conversation bridge; the task workers live in that bridge and are independent from live call and chat turns. Optional Mac overrides are `RESLU_TASK_FAST_MODEL`, `RESLU_TASK_STANDARD_MODEL` and `RESLU_TASK_STRONG_MODEL`; the strong tier defaults to `openai/gpt-5.6-sol`.

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

The bridge polls only the dedicated lightweight agent job table. It routes each RESLU conversation through a stable OpenClaw `--session-key`, sends the existing runtime the recent canonical thread history, then stores the final response in that same thread. For a newest message containing attachments, the bridge downloads those private objects into a per-job temporary directory, instructs the existing agent to inspect their local paths, and removes the directory when the synchronous agent turn finishes. A newer spoken turn cancels publication of stale output. Cancellation never claims to reverse an external side effect that already completed.

## Current release boundary

- Durable one-to-one and mixed group text conversations.
- Aria and Marco agent transport through existing runtimes.
- OpenAI Realtime WebRTC audio, semantic VAD, true barge-in, mute, repeat, voice hang-up, and call records when enabled; browser speech remains the disabled-feature fallback.
- Up to six private JPEG, PNG, WebP or PDF attachments per canonical message, 25 MB each; folders and filing to a lead/project remain later phases.
- No WhatsApp dependency.

Aria Meeting Mode’s staged minutes, destination confidence and explicit filing approval should be built next on `conversation_calls.presentation = 'meeting'`; do not publish minutes directly from raw capture.
