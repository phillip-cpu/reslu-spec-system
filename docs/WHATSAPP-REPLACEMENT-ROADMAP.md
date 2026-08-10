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
bridge is running. The first production iPhone photo reached Aria and was read
accurately. That trace took about 74 seconds: 2 seconds to upload, 38 seconds
waiting behind a cancelled voice consult, and 36 seconds in the agent runtime.
The bridge cancellation repair is in progress before the remaining Stage 1
acceptance cases.

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

Status: pending.

Work:

- Optimistic sends with sending, delivered, failed and retry states.
- Idempotent offline queue and reconnect without lost or duplicate messages.
- Per-conversation unsent drafts.
- Message push notifications, badges and unread counts.
- Notification tap opens the exact conversation.
- Pin, archive, mute, search and conversation notification preferences.
- Reply/quote, copy, edit markers, recoverable delete, forward, reactions and
  pinned messages.
- Group naming, participant management and reliable mentions.
- Voice notes and expanded safe file types after the photo/PDF slice is proven.
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

Work:

- Record end-to-end timestamps for speech stop, Realtime acknowledgement,
  consult creation, bridge claim, OpenClaw completion and first audible answer.
- Start an ordinary acknowledgement within one second of speech stop.
- Stop audible output within 250 ms of genuine interruption.
- Give a short truthful progress cue during substantive OpenClaw work.
- Stream or otherwise shorten the blocking OpenClaw response boundary where
  the runtime safely supports it.
- Test double-talk, throat clears, echo, road noise and ambiguous partial turns.
- Test speaker, AirPods, car Bluetooth, weak reception and Wi-Fi/mobile handoff.
- Reconnect without replaying stale audio or duplicating canonical messages.

Stage gate:

- Ask a contextual question, interrupt the answer, change subject, consult the
  other agent and end by voice.
- No stale audio, duplicate message or false reversal of a completed action.
- Measured latency meets the acknowledgement and interruption targets.

## Stage 4 - Native-feeling mobile and persistent desktop chat

Status: mobile foundation delivered; desktop layer pending.

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

Status: pending.

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

Status: behaviour and safeguards defined; implementation pending.

Work:

- Start Meeting Mode from an Aria thread or active call.
- Resolve calendar event, meeting type and candidate lead/project.
- Remain silent unless directly addressed.
- Display a persistent recording/listening and consent indicator.
- Checkpoint transcript, speaker information and session health.
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

Status: pending after core reliability.

Work:

- Distinct Aria and Marco identity, voice, avatar, lane and permissions.
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

Final product gate:

- Phillip completes a two-week pilot without opening WhatsApp for the agreed
  RESLU workflows.
- No critical lost-message, duplicate-action, wrong-record, privacy, call-drop
  or agent-identity defect remains unresolved.

## Current next action

Deploy the bridge cancellation repair so a cancelled voice consult releases
Aria's worker promptly. Then rerun the iPhone photo test without preceding
queue contention, complete the PDF and desktop cases, and exercise failure,
retry, chat-switching and expired-URL recovery before closing Stage 1.
