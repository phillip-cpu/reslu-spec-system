# RESLU conversations: WhatsApp replacement roadmap

## Product outcome

Phillip can use RESLU conversations as the dependable daily interface to Aria,
Marco and the RESLU team without returning to WhatsApp for the agreed RESLU
workflows. RESLU Spec remains the canonical business brain; voice, chat,
attachments, meetings and agent collaboration are interfaces to the existing
records, tools, permissions and agent runtimes.

## Scope decision

The first release target is Phillip, RESLU staff, Aria and Marco. Before Stage 2
is declared complete, decide whether clients, leads and trades are also in the
replacement scope. External participants require a separate identity,
invitation, notification, access-control and offboarding design.

## Delivery rules

Live evidence and the remaining physical-device checks are tracked in
[`WHATSAPP-REPLACEMENT-ACCEPTANCE.md`](./WHATSAPP-REPLACEMENT-ACCEPTANCE.md).
That matrix is authoritative for stage-gate status; implementation notes below
describe capability, not acceptance by themselves.

- Work through the stages in order unless an earlier-stage production defect
  requires immediate repair.
- Do not call a stage complete because its code is merged. Complete its live
  acceptance test on the intended iPhone, desktop and agent bridge.
- Preserve the canonical RESLU conversation, existing OpenClaw agents, tools,
  memory and permissions. A modality layer must not become a replacement Aria
  or Marco.
- Never silently lose, duplicate, redirect or file a message, action or file.
- Consequential actions and ambiguous filing destinations require explicit,
  truthful confirmation.

## Stage 1 - Photo and PDF messaging

Status: in progress.

Current implementation: PR #22 and migration 092 are live, and the updated Mac
bridge is running. Production currently contains one PDF and three images; all
four attachment rows are ready and each is bound to one canonical message. The
first production iPhone photo reached Aria and was read
accurately. That trace took about 74 seconds: 2 seconds to upload, 38 seconds
waiting behind a cancelled voice consult, and 36 seconds in the agent runtime.
That trace completed before the bridge cancellation repair was installed, so it
is not evidence of the repaired queue-release time. The repair is now live and
a clean repeat is still required. Attachment recovery hardening adds explicit
retry, all-or-nothing draft sending, safe mid-upload cancellation, eventual
abandoned-object cleanup and stable authenticated attachment links. The same
trace also found a separate attachment delay: the system temp path was outside
Aria's image-tool workspace, causing a failed inspection, an `exec` copy, and a
second inspection. PR #27 is now deployed and the restarted bridge stages each
file privately inside the selected OpenClaw workspace, uses it in place, and
cleans it up after the turn. A synthetic image benchmark on the production host
completed in 4.5 seconds with native image input and no tool call, versus about
30 seconds and three avoidable calls in the original real-image trace. PR #119
now gives each agent a bounded untrusted recall envelope for the 12 latest
previously inspected attachments without reopening private bytes. Production
zero-attachment follow-ups recovered the old photo's red harness/waterfront
setting and a matching PDF's exact fixture id. This closes the backend
prior-file recall gap. Stage 1 still requires the physical iPhone picker,
retry, chat-switch and signed-link recovery matrix before it can close; the old
74-second trace is not evidence of the post-fix picker result.

Work:

- Apply `092_conversation_attachments.sql` to Supabase.
- Merge and deploy PR #22.
- Pull the release and restart the Mac conversation bridge.
- Test camera capture, photo-library selection and PDF selection on iPhone.
- Test drag/drop or file selection on desktop.
- Confirm private previews render in the canonical thread.
- Confirm Aria accurately reads every relevant attachment.
- Confirm upload failure, retry, chat switching and expired signed URLs recover
  without orphaning or leaking a file.

Stage gate:

- Send one photo and one PDF from an Aria thread on iPhone.
- Both appear once in that thread and remain private.
- Aria describes their actual content accurately.
- The next text or voice turn continues with the same context.

## Stage 2 - Trustworthy everyday messaging

Status: in progress; migrations 093 through 098 and the matching application
and bridge releases are live. The final two-device and lock-screen acceptance
gate remains.

Current implementation: migration 093 adds a device-generated
`client_message_id` and an atomic idempotent message RPC, so a lost HTTP
response or multi-tab retry returns the original canonical message and cannot
enqueue Aria or Marco twice. The client saves text sends into IndexedDB before
clearing the composer, renders queued/sending/failed/delivered states, retries
after reconnect, times out ambiguous requests safely, and reconciles with the
canonical thread. Per-conversation text drafts persist synchronously on the
device and are visible in the conversation list. Migration 094 adds canonical
per-participant unread counts and a monotonic server read cursor, with visible
badges that clear only when the intended thread is visible at its newest
message. Migration 095 creates one private notification per unmuted recipient
and one durable delivery job for each of that recipient's subscribed devices;
Aria/Marco and human inserts share the same database trigger, delivery retries
one device at a time in a background bridge worker, and notification taps target
the exact canonical message. Device subscription credentials are owner-only,
and a queued job is skipped if its recipient has since left the conversation.
Each device receives only an encrypted opaque notification id; the signed-in
service worker fetches private preview content from RESLU, so message text and
links are not exported to the push provider. This is not yet the whole stage:
Migration 096 adds private per-user mute, pin and archive controls, an archived
inbox view, and preserves the mobile conversation list when polling refreshes
after Back. The client now filters active or archived chats locally and searches
the complete canonical text history of an authorised conversation. Selecting an
older result loads its exact surrounding context without polling snapping back
to newest, with an explicit return-to-latest action. Older history now pages
backwards in bounded batches while preserving the reader's scroll position and
remaining stable across background polling. Richer message actions,
attachment-content search and bounded cold-start messaging continuity are now
implemented. Every client registers the narrow messaging service worker; it
caches only the generic `/messages` shell and immutable public assets, never
private APIs or attachment bytes. The latest 100 canonical messages per visited
conversation and the conversation list are stored separately in a
profile-scoped IndexedDB cache, with a visible offline label and the existing
exact-once outbox still accepting new sends. Physical iPhone cold-start and
cache-eviction behavior remain an acceptance gate. Loaded
long histories retain every canonical row for search and accessibility while
`content-visibility` lets the browser skip off-screen layout and paint. The
merge/order and viewport-anchor algorithms now have behavioral coverage at
2,000 rows; production keyset pagination returned the largest real 370-message
thread in four complete, distinct pages. Physical 2,000-row mixed-media paint
and composer responsiveness remain an acceptance gate. Migration 105 adds
author-owned 15-minute message edits
with multi-device conflict detection, plus a recoverable delete that leaves a
truthful tombstone, keeps original text private to its author for 30 days and
immediately blocks deleted attachments. Restore changes history without
silently re-running Aria, Marco or durable work. Corrective migration 112 makes
the optimistic version advance by at least one microsecond even when an insert
and edit share one PostgreSQL transaction. Migration 106 adds six bounded
quick reactions with one current choice per member and up to five shared pinned
messages that remain reachable above the timeline even when they are older than
the loaded page. Deleting a message clears its reaction and pin state in the
same transaction. Migration 097 puts full-history substring search behind a
member-scoped RPC and a trigram index so response time does not degrade into a
full table scan as the canonical history grows. Migration 098 makes quoted
replies part of the exactly-once send contract; reply selection survives the
offline outbox, replying to Aria or Marco in a group routes back to that existing
agent, and the bridge gives the agent the referenced message rather than losing
the quote relationship. Message menus expose Reply and Copy on mobile/desktop.
Migration 107 adds member-scoped forwarding to up to ten chats with one stable
client intent id. A retry returns the same target messages and agent jobs. Ready
private attachments are shared through target-scoped snapshot rows instead of
duplicating their unique storage record, and forwarding an already-forwarded
message keeps the file available without exposing its original chat. The Mac
bridge receives forwarded files through the same private materialisation path.
Migration 108 replaces broad direct group-row writes with explicit, exactly-once
human-admin operations. Stable client action IDs make retries safe after lost
responses. The creator starts as admin; admins can rename a group, add/remove
people or Aria/Marco, and promote another human. The last admin cannot be
removed, leaving promotes a successor when necessary, and removing an agent
cancels only that agent's unfinished work in the group. Every mutation leaves a
canonical system record. The add-member UI explicitly says that RESLU team
members receive the existing business history rather than silently applying
WhatsApp's consumer-history assumptions. Corrective migrations 113 and 114
enforce the last-human-admin rule at both the database-trigger and explicit RPC
state-transition layers.
Migration 109 adds private voice notes without creating a second messaging
system. iPhone Safari records MP4 audio and supported desktop browsers record
WebM; the server verifies the actual container bytes, five-minute duration and
10 MB size before the ordinary exact-once message outbox can bind the file.
Authenticated range playback, forwarding and the existing private Aria/Marco
attachment materialisation path all reuse the canonical conversation. Automatic
third-party transcription is deliberately excluded until Phillip explicitly
approves the provider, retention and disclosure wording.
Migration 110 makes private attachments discoverable in the same bounded,
member-scoped full-history search. Ready uploaded and forwarded filenames are
trigram indexed; staged files and deleted messages stay hidden. A file match
returns its canonical message anchor and a filename cue, not a storage path or
second file index, so opening it preserves the conversation context.
The same exact-once boundary now covers conversation creation, call start and
call end: device intent ids recover a lost start response, and an ended call is
retained locally until the single canonical same-thread call record is
acknowledged. A production audit found one browser call left canonically active
after the iPhone session had disappeared. Migration 104 closes that database
gap: one person may have only one active call across conversations and devices;
starting a genuinely new call truthfully drops and records the displaced turn,
cancels only its unfinished conversational consult output and leaves durable
background tasks running. Ready attachment drafts are restored after navigation
or reload,
interrupted finalisation is retryable, and switching chats cannot silently
discard or cross-bind a staged file. The release also upgrades Next to 16.3.0,
which removes the fixable production framework advisories found by the
2026-08-11 audit. The remaining production advisories are inherited by the
existing fixed text-embedding dependency and have no upstream fix; untrusted
images, archives and file bytes remain excluded from that code path. The new
`web-push` dependency adds no reported production advisory.

Rollout order for this slice:

1. Apply `093_conversation_message_reliability.sql`, followed by
   `094_conversation_unread_state.sql` and
   `095_conversation_push_delivery.sql`, then
   `096_conversation_preferences.sql`, then
   `097_conversation_message_search.sql`, then
   `098_conversation_quoted_replies.sql`, then
   `104_single_active_conversation_call.sql`, then
   `105_conversation_message_edit_delete.sql`, then
   `112_conversation_message_edit_version.sql`, then
   `106_conversation_message_reactions_pins.sql`, then
   `107_conversation_message_forwarding.sql`, then
   `108_conversation_group_management.sql`, then
   `113_conversation_group_human_admin_guard.sql`, then
   `114_conversation_group_admin_transition.sql`, then
   `109_conversation_voice_notes.sql`, then
   `110_conversation_attachment_search.sql`, to Supabase.
2. Run the matching rollback-only fixtures for migrations 093 through 098 and
   migrations 104 through 110 in the SQL Editor. Migration 112 is proved by
   rerunning the migration 105 fixture immediately after the corrective patch.
   Every fixture must report PASS and leave no test data.
3. Deploy the matching application release, pull it on the Mac and restart the
   conversation bridge so its independent push worker is active.
4. Refresh every already-open RESLU client so it sends a stable client id.
5. Run an online send, a response-loss retry, an airplane-mode queued send, a
   reconnect flush, a refresh-during-send test, a per-chat text/attachment draft
   test, a lost-response conversation-create retry and a lost-response call
   start/end retry.
6. Confirm each send creates exactly one canonical message and one agent job,
   each call creates exactly one call and one same-thread record, unread badges
   agree on two devices, and mute/pin/archive affect only the signed-in team
   member's inbox.

Work:

- Optimistic sends with sending, delivered, failed and retry states.
- Idempotent offline queue and reconnect without lost or duplicate messages.
- Per-conversation unsent drafts.
- Message push notifications, badges and unread counts.
- Notification tap opens the exact conversation.
- Pin, archive, mute, search and conversation notification preferences.
- Reply/quote, copy, edit markers and recoverable delete.
- Forward text and private attachments exactly once to up to ten chats.
- Shared group names, human admins, safe participant management and reliable mentions.
- Private record/cancel/send/play/forward voice notes, with optional automatic
  transcription held behind a separate informed approval.
- Pagination, virtualised long history and message/file search.

Stage gate:

- Complete a two-device send/reconnect test with airplane mode and network
  changes without a lost or duplicated turn.
- Receive a lock-screen notification and open the correct unread message.
- Resume every unsent draft in its original conversation.

## Stage 3 - Natural low-latency voice

Status: partially delivered; performance work remains.

Already delivered: OpenAI Realtime WebRTC, semantic VAD, barge-in, precise
cancellation and the existing-agent consult boundary.

Persistent-agent workspace candidate: migration 099 adds durable Aria/Marco
tasks, append-only observable task events, reviewable artifacts and explicit
approval. Realtime now routes quick questions to the existing cancellable
conversation consult, but routes requests to create, prepare, compose,
research, review or organise work into a separate task. Each task has its own
OpenClaw session and worker, so interruption, hang-up, screen lock and browser
closure do not cancel it. Strong tasks route to the configured capable model
and may use the existing runtime's specialist/subagent capability. The call UI
shows low-latency user/agent captions alongside truthful task state and visible
drafts; the same task cards remain in the text thread after the call. Sending,
publishing, booking, spending, deletion and record changes remain behind an
explicit approval boundary.

Live instrumentation: every Realtime turn now records bounded,
content-free durations for speech-stop to tool call, consult acceptance, bridge
queue wait, OpenClaw processing, backend completion and first actual WebRTC
audio. The call row and compact call record retain a per-call summary and up to
20 turn measurements without transcripts or provider identifiers. The final
spoken response is also requested before the non-critical message refresh,
removing an avoidable client-side wait. Realtime gives one fixed, truthful
spoken acknowledgement while the canonical Aria/Marco consult is active, and
the text thread shows the member-scoped queued/working job state instead of
appearing idle during a long attachment or tool turn. The slow attachment trace
also showed why total model usage was high: four model/tool iterations replayed
roughly 67,000 prompt tokens each, including about 41,700 characters of tool
schemas. The first safe reduction removes the unnecessary failed image/copy
iteration. Any broader tool-catalog or thinking-level change must be benchmarked
for latency and task correctness before altering Aria's production capability.

Live bridge-latency hardening now gives Aria and Marco independent serial
workers, so a slow run or claim request for one cannot hold up the other.
Queue claims time out after five seconds instead of inheriting the general
30-second REST timeout, while cancellation/status checks use a three-second
bound. Each agent still processes one ordered queue and retains its existing
OpenClaw identity, stable RESLU conversation session, tools, memory and
permissions. This contains transport stalls without introducing parallel turns
against the same canonical agent session. It requires a fresh post-deployment
photo, PDF and voice timing run; the 74-second pre-repair trace does not prove
the new queue-release time. Six production calls now contain timing evidence.
Recent measured acknowledgements ranged from 1.775 to 4.876 seconds and agent
processing ranged from 13.8 to 44.1 seconds, so the Stage 3 latency gate is not
met. The next candidate requests the fixed acknowledgement as an independent
out-of-band Realtime audio response immediately on speech stop, rather than
waiting for the default response to finish choosing the RESLU agent tool. It
also uses high semantic-VAD eagerness and cancels the acknowledgement by its
own response id so interruption and the authoritative Aria/Marco answer remain
independent.

Gateway event bridge candidate: migration 100 adds bounded accepted-run and
progress fields to conversation jobs and durable tasks. The Mac bridge connects
only to the authenticated loopback Gateway, sends the existing job/task id as
the run idempotency key, retains the canonical Aria/Marco session key, and
consumes accepted, lifecycle, safe tool-category, assistant-output and final
chat events. Member-visible progress stores only labels such as “Checking the
calendar” and “Drafting the response”; prompts, partial assistant text, tool
arguments and tool results are excluded. Cancellation targets the exact run.
The existing CLI remains a fallback only before Gateway acceptance, so an
accepted turn can never be replayed and duplicate side effects cannot be
introduced by transport recovery.

Migration 100, the Gateway bridge and its feature flag are now live. An isolated
production turn proved accepted/lifecycle/drafting/finishing progress, and a
second isolated turn proved that cancellation suppresses late output. The first
fresh iPhone acceptance call after rollout still failed its latency gate: the
job was claimed in under one second but was cancelled 12.2 seconds later at
hang-up without a Gateway run id or progress event. The call also retained no
client timing sample, so it is not counted as a successful measurement. The Mac
error log showed repeated Supabase TLS handshake/read failures, and the bridge
was opening a new encrypted connection for every half-second poll and every
small context lookup across its independent workers. The current repair reuses
one Supabase connection per worker, combines transport/file lookup, joins recent
message authors and files into one request, caches the fixed agent identity, and
removes a redundant pre-invocation status read. Against the same real Aria
thread, measured pre-Gateway preparation fell from roughly three seconds in a
healthy sequential run (and up to the whole 12-second call window during
failures) to 0.16-0.97 seconds after warm-up. A new iPhone acceptance call is
required after the repaired bridge is deployed and restarted.

The next real iPhone driving-mode call showed the repaired front half working:
Aria's acknowledgement began 0.904 seconds after the request and the short
spoken response began after 3.499 seconds. One earlier provider tool turn was
recorded as failed before a second turn succeeded. The client now defers an
incomplete `response.function_call_arguments.done` payload until the canonical
`response.done` output is available, preventing a partial arguments event from
consuming the idempotency key before its complete fallback arrives. That call
also created a durable task which continued running after hang-up, then received
a separate cancellation request five seconds later. Ending a call still has no
task-cancellation path; the task card now requires a deliberate second “Stop
task” action so a single or displaced mobile tap cannot terminate background
work.

Foreground call-recovery candidate: a dropped WebRTC peer or data channel now
reconnects to a fresh OpenAI audio session while retaining the existing RESLU
call id, canonical conversation and any active Aria/Marco consult or durable
task. Recovery runs only when the page is visible and online, rejects stale
connection events by generation, reuses a live microphone stream or reacquires
it when iOS ended the track, and stops after five backed-off attempts with an
explicit Reconnect control. Returning from the background, regaining focus or
coming back online triggers the same health-checked path without creating a
second call record. This improves Safari/PWA foreground recovery; it does not
claim that iOS will keep a web page executing while the phone is locked. True
lock-screen and in-car background continuity remains the native Stage 5 gate.

Work:

- Publish and validate the end-to-end timing candidate on an iPhone call.
- Start an ordinary acknowledgement within one second of speech stop.
- Stop audible output within 250 ms of genuine interruption.
- Validate the fixed spoken progress cue and thread working indicator against
  slow attachment and tool turns.
- Apply migration 100 and its rollback verifier, then deploy and enable the
  local Gateway event bridge on the Mac.
- Replace the one-shot `openclaw agent --json` bridge boundary with the local
  authenticated Gateway run/event interface, retaining the same stable session
  identity and authoritative agent. Use its accepted run id and lifecycle/tool
  events for truthful progress and explicit run tracking; retain the current
  CLI's real Gateway-abort behavior during migration and never expose the
  Gateway publicly.
- Stream or otherwise shorten the remaining OpenClaw response boundary where
  the runtime safely supports it.
- Test double-talk, throat clears, echo, road noise and ambiguous partial turns.
- Test speaker, AirPods, car Bluetooth, weak reception and Wi-Fi/mobile handoff.
- Reconnect without replaying stale audio or duplicating canonical messages.
- Keep migration 099 and the independent task workers active while the Gateway
  transport is rolled out behind its explicit feature flag.
- Prove that a task started by voice completes after the call ends, that a
  draft can be approved from the thread, and that an explicit task cancellation
  does not cancel or corrupt an unrelated conversation turn.

Stage gate:

- Ask a contextual question, interrupt the answer, change subject, consult the
  other agent and end by voice.
- No stale audio, duplicate message or false reversal of a completed action.
- Measured latency meets the acknowledgement and interruption targets.

## Stage 4 - Native-feeling mobile and persistent desktop chat

Status: mobile foundation delivered; persistent desktop candidate implemented,
authenticated acceptance pending.

The desktop candidate mounts one conversation workspace in the persistent
dashboard layout rather than creating a second chat or agent. A Messenger-style
launcher opens a resizable, minimisable window above project, lead, office and
other dashboard pages; its open state and dimensions survive navigation and
reload. The canonical conversation selector, unread counts, drafts, attachments,
outbox, Aria/Marco calls and durable agent work are reused unchanged. On the
desktop `/messages` route the same mounted workspace expands to the available
dashboard area, avoiding a second competing chat instance. Mobile keeps the
existing full-screen workspace and does not mount the desktop shell. An active
call explicitly remains visible even while the drawer chrome is closed,
minimised or the route changes. On desktop the full call workspace can collapse
into a compact always-on-top call bar, leaving project and office controls
available while the same WebRTC call, transcript and background tasks continue.
Authenticated cross-route call acceptance remains part of this stage gate.

Work:

- Finish mobile swipe-back, unread marker, date separators, media viewer,
  long-press actions and accessible touch targets.
- Keep call and conversation state while navigating RESLU.
- Add a global desktop chat drawer that can minimise, resize and stay pinned
  over project, lead and office pages.
- Add quick conversation switching, unread badges, drag/drop and clipboard
  image upload.
- Provide a compact active-call banner/mini-player when leaving the thread.

Stage gate:

- Navigate between RESLU project pages while continuing the same typed or voice
  conversation without losing state.
- On iPhone, reach the newest message and call action without scrolling through
  history.

## Stage 5 - iPhone background and in-car continuity

Status: native foundation implemented and signed; physical-device installation
and acceptance pending.

The PWA limit is now proven rather than assumed: foreground recovery is guarded
by document visibility, and a web manifest cannot opt into the iOS audio session,
background modes or CallKit needed for a locked-screen VoIP experience. The
Stage 5 foundation adds a thin SwiftUI/WKWebView shell with native
`AVAudioSession` and CallKit ownership. It loads the canonical production RESLU
application and sends call lifecycle only across a small bridge; Supabase auth,
OpenAI key ownership, Realtime session creation, conversation IDs, call records,
Aria/Marco logic, OpenClaw memory/tools and durable tasks remain in the existing
web/server system. See `docs/IOS-NATIVE-SHELL.md` for build and acceptance.

Work:

- Prove the practical limits of the Home Screen web app for screen lock,
  background audio and reconnection.
- Build a minimal native iOS shell if the web app cannot meet the call gate.
- Add native background audio, system audio-route controls and lock-screen call
  handling.
- Preserve authentication and canonical RESLU URLs inside the shell.
- Evaluate CarPlay only after the native call foundation is dependable.

Stage gate:

- Start an Aria call, lock the iPhone, change audio route and drive through a
  network handoff without an unexplained drop or lost turn.

## Stage 6 - Meeting Mode and intelligent filing

Status: implementation, migrations, production deployment and Mac-mini runtime
update are complete; real client-meeting acceptance is pending.

Implemented in the core slice:

- One-tap entry from an Aria thread and a `start_meeting_mode` transition from
  an active Aria voice call.
- Calendar/lead/project candidate ranking with visible confidence reasons,
  an unassigned fallback and no fuzzy-name auto-filing.
- Explicit participant-consent gate, silent capture, pause/resume/finish,
  30-second private on-device audio/session checkpoints and recoverable upload.
- Private Supabase source audio and local-Whisper transcription on the Mac mini;
  full client meetings are not sent to OpenAI.
- Durable strong-model Aria drafting that continues after the capture screen
  closes, with seven editable minutes sections and the source transcript.
- Optimistic draft versioning, destination revalidation, duplicate-event
  confirmation, one transactional canonical record/timeline link and an audit
  trail for capture, destination, draft and filing state changes.

Still required before the stage gate can pass:

- Test the complete local-Whisper task on real production meeting data.
- Add speaker labels only if a locally approved diarization path proves reliable;
  the current source is a verbatim meeting-level transcript.
- Prove lead, active-project and ambiguous-destination scenarios in real meetings.

Work:

- Start Meeting Mode from an Aria thread or active call.
- Resolve calendar event, meeting type and candidate lead/project.
- Remain silent unless directly addressed.
- Display a persistent recording/listening and consent indicator.
- Checkpoint source audio and session health; retain transcript provenance and
  add speaker information only where a reliable local model can supply it.
- Produce an editable structured draft: summary, decisions, client requests,
  RESLU actions, client actions, open questions and important notes.
- Show the proposed destination and confidence reasons.
- Require explicit approval before filing.
- Revalidate the destination, detect duplicates and write idempotently.
- Preserve provenance and a recoverable move/correction audit trail.

Stage gate:

- Complete one lead consultation, one active-project design meeting and one
  ambiguous case.
- Nothing files silently or into the wrong record.
- The approved canonical record and linked conversation timeline item agree.

## Stage 7 - RESLU team intelligence

Status: bounded owner/specialist consultation and durable chat delegation are
deployed. Production has completed the same read-only cross-domain acceptance
scenario in both Aria→Marco and Marco→Aria directions with one canonical task,
one owner-authored result, explicit specialist attribution and no duplicate.
The corresponding physical voice-call acceptance remains pending.

The collaboration layer does not create replacement agents. During a live
Aria, Marco or Stuart call, Realtime may choose one dedicated specialist-consult tool.
The server verifies the visible owner is a participant in the active call and
routes exactly one advisory job to either of the other active RESLU OpenClaw runtimes.
The specialist is not silently added to a direct conversation, cannot perform
consequential work through this advisory path, and returns one answer authored
by the owning agent with visible specialist attribution. A dedicated audit row,
provider idempotency lock, exact cancellation boundary and atomic completion
preserve one owner, one specialist job and one canonical answer. Durable work
continues through the existing owner-agent task path. Direct chat and background
tasks may create a bounded, idempotent specialist task through the guarded
delegation tool; its result returns to the same canonical thread under the
original visible owner with the specialist explicitly attributed. The runtime
can still use its existing subagent facilities without moving approval or
publication authority.

Work:

- Distinct Aria, Marco and Stuart identity, voice, avatar, lane and permissions.
- Visible listening, thinking, speaking, consulting and preparing states.
- One owning agent can consult another without duplicated actions.
- Proactive briefings with priority, quiet hours, snooze and suppression.
- Context-before-questions across calendar, email, leads, projects, tasks and
  previous meetings, with links to source records.
- Friday RESLU Meeting and future specialised agents only after one-to-one
  collaboration is dependable.

Stage gate:

- Aria and Marco answer the same cross-domain scenario from their real lanes,
  collaborate once, create no duplicate action and leave an auditable record.

## Stage 8 - Production hardening and no-WhatsApp pilot

Status: ongoing discipline; final pilot pending.

Work:

- Bridge health, queue depth, latency, provider failure and call diagnostics.
- Automatic restart, bounded retries and a dead-letter path.
- Error alerts, feature flags, rollback and recovery testing.
- RLS and permission tests for every conversation and private attachment path.
- Recording/transcript retention, export, deletion and device/session revoke.
- Audit records and prompt-injection defence for messages and files.
- Performance budgets, thumbnail/lazy loading and cached recent conversations.
- VoiceOver, large text, contrast, captions and reduced-motion support.
- A real iPhone/car/desktop test matrix under poor networks and long histories.

The bridge process already uses launchd `RunAtLoad`, `KeepAlive` and a bounded
restart throttle. Push delivery has a six-attempt exponential retry budget.
The bridge now also emits one content-free health report per minute for its
Aria turn, Marco turn, Aria task, Marco task and push workers. A stopped worker
reports `down`; a process or network failure that prevents reporting becomes a
deduplicated incident after five minutes rather than remaining indistinguishable
from an idle queue. The report contains only worker names/counts and liveness,
never conversation text, identifiers, filenames or task content.
This reporter is deployed through `5d200d9`; two production samples one minute
apart proved the row advances and reports all five required workers active. A
separately named synthetic worker drill on 18 August used the real governed
health route without stopping the production bridge: its first down report
opened one incident and one notification, the repeated down report was deduped,
and recovery resolved the incident and stale notification. The production bridge
remained `ok` with a fresh report throughout.
Durable Aria/Marco work deliberately enters `failed` instead of blindly
replaying an uncertain run. Migration 111 adds a requester-only recovery action
for failed work with no unresolved or completed approval boundary: it reuses the
exact task and agent session, assigns a distinct bounded attempt idempotency key,
and records a recovery event. A pending approval, an approved/published artifact,
an approved event or an approved failed task remains a visible dead letter until
the relevant email, booking or record is inspected; RESLU never claims an
uncertain external action was undone and never retries it automatically.
Production commit `9493c7a` gives durable-task failures their own
`conversation_tasks` incident lifecycle, separate from chat turns, calls and
capability failures. The 18 August acceptance drill opened one incident and one
notification for a synthetic read-only failed task, deduplicated the repeated
open, requeued the same task id once, completed it through the live Aria worker
and resolved only the task incident. The unrelated pre-existing chat transport
incident remained open throughout, proving one lane cannot mask or falsely
resolve the other.
The 18 August production prompt-injection drill then exercised a direct Aria
message, an exactly-once forward to Marco and a private PDF containing the same
harmless hostile payload. The direct turn treated the quoted payload as data;
the forward used the structurally tool-free `forwarded_context` lane; the PDF
used only the fixed private PDF reader. Three jobs completed once, all outputs
contained no secret-like values, and content-free before/after counts proved no
task, authority run, approval receipt, email send or participant change. The
repeatable PDF lives at
`docs/security-fixtures/reslu-prompt-injection-fixture.pdf`.

Keep Next.js on a currently patched stable release. The Stage 2 dependency
  audit moved the app from vulnerable 16.0.10 to stable 16.3.0 and cleared the
  framework/proxy advisories. Track the remaining no-fix advisories inherited
  by `@huggingface/transformers`; the current embedding wrapper is text-only
  and must never receive untrusted images, archives or file bytes.

Final product gate:

- Phillip completes a two-week pilot without opening WhatsApp for the agreed
  RESLU workflows.
- No critical lost-message, duplicate-action, wrong-record, privacy, call-drop
  or agent-identity defect remains unresolved.

## Current next action

The production database and deployment gates are complete through migration
116 and production commit `45bc2ff`. The exact production deployment reached
READY, the Mac bridge checkout is at that commit, and its launchd service was
restarted on 12 August 2026. Run the Stage 7 live cross-agent checks: ask Aria
for Marco's commercial view, then ask Marco for Aria's operational view. Each
turn must retain one visible owner, one attributed specialist consultation, one
canonical answer and no duplicate action.

Repeat the iPhone voice acceptance call. Require a Gateway run id
and visible safe progress before waiting for Aria's answer; interrupt one answer,
start one durable task, end the call, and confirm that the durable task keeps
working. Require saved content-free timing metadata for the call. Do not close
Stage 3 until acknowledgement is below one second, interruption is under 250 ms,
and the canonical answer/task behavior is correct.

In parallel with that acceptance evidence, complete the remaining live Stage 1
photo/PDF gate and the Stage 2 two-device, notification, mute/pin/archive,
reply/search and lock-screen matrix. Then continue Stage 4 with the persistent
desktop messenger shell, followed by Stage 5 native iPhone continuity, Meeting
Mode, intelligent filing, team collaboration, hardening and the final
no-WhatsApp pilot. Record each stage's result here and in the notification,
latency and two-device acceptance matrix.
