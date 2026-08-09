# RESLU realtime voice plan

## Decision summary

The current browser speech call must remain a fallback, not the target architecture. It is a complete-turn pipeline:

1. iPhone Web Speech waits for an utterance to become final.
2. The browser posts one completed transcript.
3. Supabase creates and the Mac mini claims an `agent_conversation_jobs` row.
4. `conversation_agent_bridge.py` blocks on `openclaw agent --json` until the entire Aria or Marco turn, including tools, is finished.
5. The browser polls Supabase every 1.2 seconds during a call.
6. Only after the complete agent message exists does browser `speechSynthesis` begin playback.

This explains the stop-start experience. Endpoint tuning can remove hundreds of milliseconds, but it cannot remove the blocking agent boundary or provide genuine duplex audio.

The recommended target is WebRTC to the OpenAI Realtime API, using `gpt-realtime` initially. Server VAD supplies speech start/stop events and interruption; an interrupted WebRTC response is cancelled and its unplayed audio is truncated. Standard API keys remain server-side.

## Preserve Aria and Marco

The realtime model must not become a replacement Aria or Marco. It is the low-latency voice and turn-taking layer.

- Give each realtime session a bounded identity capsule for the selected participant (`main` for Aria, `marco` for Marco), conversation title and recent canonical messages.
- Let the realtime layer answer only lightweight conversational acknowledgements and clarify incomplete speech.
- Expose one server-owned `consult_reslu_agent` function for substantive answers, memory, calendars, email, business data or any tool use.
- Route that consult to the existing OpenClaw agent and a stable session key derived from the RESLU conversation ID. Existing OpenClaw memory, permissions, tools and business rules remain authoritative.
- Use a conservative consult policy: anything that could depend on current RESLU state or cause a side effect must consult. The realtime model must never independently perform a business action.

This mirrors OpenClaw's own realtime Voice Call design, which exposes `openclaw_agent_consult`, supports bounded agent identity context and reuses the configured agent session.

## Server and client boundaries

### Browser

- Capture/play audio through a WebRTC peer connection.
- Send and receive Realtime data-channel events.
- Reflect `speech_started`, `speech_stopped`, response, consult and reconnecting states.
- On user speech, immediately stop local playback and mark the current response cancelled.
- Never receive `OPENAI_API_KEY`, an OpenClaw gateway credential or a Supabase service-role key.

### Vercel

- Authenticate the RESLU user and verify conversation membership.
- Create the Realtime WebRTC session through a server-mediated SDP route, or mint a short-lived Realtime client secret. Prefer the unified SDP proxy first because it keeps the standard key fully server-side.
- Supply only allow-listed session instructions, voice/model settings and the `consult_reslu_agent` tool definition.
- Accept completed transcript/response events idempotently and persist canonical `conversation_messages` rows.
- Enqueue consults with opaque call, response and tool-call IDs. Never trust browser-supplied agent IDs without rechecking conversation participants.

### Mac mini

- Claim realtime consult jobs and invoke the existing selected OpenClaw agent.
- Keep the stable RESLU conversation-to-OpenClaw session mapping.
- Return tool output and auditable action results. Cancellation may stop waiting or suppress late speech, but it must not claim that an email, approval, calendar change or other completed side effect was undone.

The safest first bridge remains an outbound Supabase job/result channel. Do not expose the Mac mini's full-operator OpenClaw Gateway API publicly merely to reduce latency.

## Canonical history and cancellation

- Persist a final human transcript only once Realtime commits the input audio turn.
- Persist the final delivered assistant transcript, not every audio delta.
- Store provider call/response/item IDs in metadata for idempotency and diagnostics.
- When VAD reports new user speech, cancel the active Realtime response immediately. Ignore later completion events for that cancelled response and never play or persist them as a completed assistant turn.
- A consult job may already have used a business tool. Cancellation suppresses its conversational output only; it does not reverse side effects. Existing action/audit records remain canonical.
- Ending a call appends the existing `call_record` message and leaves text/voice turns in the same RESLU thread.

## Configuration required

Vercel server environment:

- `OPENAI_API_KEY`: project API key with Realtime access and billing credits.
- `RESLU_REALTIME_VOICE_ENABLED=true`: explicit rollout gate.
- `RESLU_REALTIME_VOICE_MODEL=gpt-realtime`: configurable model, default only after evaluation.
- `RESLU_REALTIME_VOICE_NAME`: selected approved voice after a product listen-test.

No standard API key is ever exposed to the client. If the ephemeral-token flow is chosen later, Vercel creates the short-lived client secret and returns only that secret.

Mac mini:

- Existing Supabase service-role configuration and OpenClaw agents.
- A new realtime-consult bridge worker or an extension of the conversation bridge.
- No OpenAI credential is needed on the Mac mini when Vercel owns Realtime session creation.

Product decisions still required:

- Approve OpenAI Platform spend and create the project API key; ChatGPT/Codex subscriptions do not fund API Realtime usage.
- Choose/test the Aria and Marco voices.
- Confirm whether lightweight social replies may be answered by the realtime layer without consulting OpenClaw. Recommended: yes for acknowledgements only; consult for all substantive RESLU answers.

## Staged migration

1. **Layout and instrumentation:** ship the iPhone viewport repair; add call/turn/provider IDs and latency timestamps before comparing transports.
2. **Feature-gated WebRTC spike:** authenticated SDP proxy, one direct Aria thread, no business tools, no production default.
3. **Consult adapter:** add `consult_reslu_agent`, stable conversation session routing and queue/result cancellation tests.
4. **Canonical persistence:** idempotent final transcripts, cancelled-response suppression and call records.
5. **Pilot:** Phillip only, then Tennille; measure speech-stop to first audio, interruption time, consult latency and failed reconnects.
6. **Default:** switch calls to realtime after the pilot meets the acceptance targets; retain the current browser speech path as fallback.

## Acceptance targets

- Ordinary acknowledgement begins within one second of speech stop on a normal mobile connection.
- Barge-in stops audible output within 250 ms and no cancelled late output plays over the next turn.
- A substantive consult visibly acknowledges immediately, then hands off to the existing agent without duplicating a tool action.
- Every completed text and voice turn remains in the same canonical RESLU thread.
- Refresh/reconnect never repeats already delivered audio or duplicates a canonical message.
