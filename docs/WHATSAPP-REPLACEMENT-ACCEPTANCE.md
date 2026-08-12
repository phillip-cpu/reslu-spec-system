# RESLU WhatsApp replacement acceptance matrix

Last updated: 12 August 2026 (ACST)

This document records live acceptance evidence for
`WHATSAPP-REPLACEMENT-ROADMAP.md`. A migration, merged pull request, green
build or plausible production row is not by itself a passed product gate.

## Status vocabulary

- **PASS**: the complete stage gate was exercised on the intended live clients
  and the authoritative records agree.
- **PARTIAL**: some requirements have direct evidence, but at least one part of
  the stage gate is missing or failed.
- **PENDING**: the required live exercise has not yet been run.
- **FAIL**: a live exercise contradicted a stage requirement.

## Current matrix

| Stage | Status | Direct evidence | Evidence still required |
| --- | --- | --- | --- |
| 1. Photo and PDF messaging | **PARTIAL** | A clean production JPEG and PDF each uploaded once, became `ready`, bound to one canonical message and produced one completed agent job. The actual files were inspected independently and Aria described both accurately. | From the same Aria thread on iPhone, ask one explicit follow-up about each file and verify the answer uses the prior attachment without re-upload. Exercise camera capture, library selection, PDF selection, retry, chat switching and signed-link recovery. |
| 2. Trustworthy everyday messaging | **PARTIAL** | Migrations 093-098 and matching verifiers were applied successfully; exactly-once, drafts, unread, push, preferences, search and quoted-reply paths have focused automated coverage. A production audit found seven successful push sends and no failed job among the latest 27 deliveries. The stacked client keeps history fetches bounded to 100 messages and lets the browser skip layout/paint for off-screen rows without removing them from search or accessibility. | Subscribe a second device, then complete the two-device online/offline/reconnect matrix, receive a real lock-screen message notification, open its exact unread message, restore text plus attachment drafts in their original conversations, after migration 109 is live record/cancel/send/play/forward one iPhone voice note, after migration 110 is live find one uploaded and one forwarded file by filename and open their exact messages, and scroll a production thread with at least 2,000 mixed text/photo/file rows without a visible jump or stalled composer. |
| 3. Natural low-latency voice | **PARTIAL** | Latest driving call acknowledged in 904 ms, began its short spoken result in 3,499 ms and started a Gateway-backed durable task that continued after hang-up. The authoritative interruption-buffer metric is now deployed. | Run a fresh iPhone call and prove output clears within 250 ms after genuine barge-in. Complete the full contextual-question, interruption, subject-change, cross-agent consultation and voice-ended call gate without stale audio or duplicate canonical output. |
| 4. Native-feeling mobile and persistent desktop chat | **PARTIAL** | Persistent desktop messenger, mini-player, local-date separators, scroll-safe touch long-press actions, an in-app full-screen private photo viewer and guarded left-edge swipe-back are merged and deployed through production commit `74f66d1`. Mobile has a sticky call action and newest-message layout. | In an authenticated production desktop session keep one typed turn and one call alive while navigating project, lead and office routes. On iPhone, prove newest message and call action are reachable without scrolling history; long-press a message while stationary and while scrolling; open and close a private image without losing thread position; swipe back horizontally and prove vertical scrolling, sending and voice-note recording cannot trigger an accidental chat switch. |
| 5. iPhone background and in-car continuity | **PENDING** | The native CallKit shell is merged on `main`. Browser foreground recovery and the screen wake-lock mitigation are deployed through `0b0f83e`; the latter prevents ordinary auto-lock but does not claim side-button lock continuity. The native shell waits for CallKit audio activation before WebRTC capture, fails closed after five seconds, permits bounded background reconnect only inside the trusted shell and keeps system mute synchronized with the web microphone. | Install/activate full Xcode, compile and install the native target, then pass a physical-device call across deliberate screen lock, mute, audio-route change and Wi-Fi/mobile handoff. If WKWebView still suspends WebRTC, move the peer/audio transport into native code rather than adding another browser workaround. |
| 6. Meeting Mode and intelligent filing | **PENDING** | Migration 103 and its rollback verifier passed production; silent capture, checkpointing, shared draft review, recorder-only capture/discard control, event-specific ambiguity detection, destination revalidation, explicit filing and audit safeguards are merged and deployed. The private recording namespace is database-confined and immutable after upload; the finish boundary verifies stored bytes before local Whisper receives the source. The Mac mini checkout was fast-forwarded to `c6258c9` and `ai.reslu.conversation-bridge` restarted healthy on 12 August. | Pass one real lead consultation, one active-project meeting and one ambiguous-destination meeting, including two nearby events for the same project. Prove the local-Whisper task completes, nothing files before approval, any destination correction requires renewed approval, and the canonical record agrees with its linked conversation item. |
| 7. RESLU team intelligence | **PENDING** | Canonical Aria/Marco identities and one-agent consultation boundary already exist. | Pass one real cross-domain collaboration scenario with correct lanes, one owner, no duplicate action and an auditable record. |
| 8. Hardening and no-WhatsApp pilot | **PENDING** | Production has RLS verifiers, bounded voice/Gateway metadata, content-free queue/task/call/latency diagnostics, session revocation, prompt-boundary hardening and approval-safe failed-task recovery through `74f66d1`. Automated accessibility contracts cover visible focus, reduced motion, 44 px controls, modal semantics and live announcements. Migration 115 and its verifier are live through `c6258c9`: members can export transcripts/bundles, only the recorder can export raw audio or explicitly delete source material, and filed minutes remain canonical. Proposed 30/365-day dates are visible but automatic purge remains disabled pending approval. | Induce/recover one isolated failed test task to prove alert dedupe/resolution and same-task requeue without private content; exercise a harmless prompt-injection fixture in a message, forwarded message and PDF and prove it cannot reveal a secret, change permissions, invoke an unrelated tool or authorize an action; complete the live keyboard, VoiceOver, Reduce Motion, dynamic text, contrast and physical touch-target matrix; prove another device cannot refresh after revocation and stops receiving push; approve or change the proposed retention periods before enabling automatic purge; complete the remaining security, poor-network and long-history matrices; then complete a two-week agreed-workflow pilot without opening WhatsApp and without an unresolved critical defect. |

## Production release state: 12 August 2026

This is deployment evidence only; it does not promote any live stage gate.

- The reviewed conversation stack from PRs #47-68 is merged through production
  commit `74f66d1`; browser wake lock is live through `0b0f83e`, and Meeting
  source privacy is live through `c6258c9`. The exact `c6258c9` Vercel
  production deployment reached READY.
- The complete changed-surface suite passes 119 TypeScript contracts and 50 Mac
  conversation-bridge tests. TypeScript and the 100-route production build pass.
- Production migration 105 passes after corrective migration 112. Migrations
  106 and 107 also pass their rollback verifiers. Migration 108's first live
  verifier found that sole-admin demotion could short-circuit as a no-op;
  corrective migrations 113 and 114 now enforce the invariant at both the RPC
  and database-trigger layers, and the strengthened migration 108 verifier
  passes with all test state rolled back.
- Migrations 109 (bounded private voice notes), 110 (private attachment filename
  search), 103 (review-before-filing Meeting Mode), 111 (approval-safe task
  retry), and 115 (Meeting source privacy) pass their production rollback
  verifiers. The database and deployment gates are complete; live client
  acceptance remains.
- Pre-production review made migration 106 table grants explicitly read-only,
  required current membership again on migration 107 forwarding retries,
  blocked migration 108 from treating an Aria/Marco auth profile as a human,
  confined and byte-verified migration 103 Meeting Mode recordings, and made
  migration 111 refuse ambiguous approval-bearing task retries.
- The native source/static contracts pass, but this Mac has only Command Line
  Tools. A full Xcode install, simulator compile, signing and the physical
  lock-screen/Bluetooth/network-handoff matrix remain required.
- The Mac mini runtime checkout is at `c6258c9`. Its launchd-managed
  `ai.reslu.conversation-bridge` service was restarted and returned to both
  `conversation-push` and Aria/Marco listening states.

## Stage 1 evidence: 11 August 2026 production trace

### Photo

- Attachment: `94330870-63bd-4711-896a-9829bf5c3097`
- Type and size: JPEG, 1,247,432 bytes
- Upload to `ready`: 177 ms
- Ready to canonical message binding: 2,701 ms
- Canonical result: one attachment, one message, one completed agent job
- Aria identified a small pug in a red harness on a waterfront path. Independent
  visual inspection agreed.

### PDF

- Attachment: `009ee03d-cf36-47e8-8c75-e3edda8ada92`
- Filename: `260623_Gerardis_Front Fence_for approval_p2.pdf`
- Type and size: PDF, 1,042,707 bytes
- Upload to `ready`: 413 ms
- Ready to canonical message binding: 6,384 ms
- Canonical result: one attachment, one message, one completed agent job
- Independent rendering showed a RESLU cover and sheets A101-A103 for the
  Gerardis front fence at 337 Military Road. Aria accurately identified the
  location/site plan, demolition and proposed fence details, and rendered
  perspective.

The next user message after the PDF was only `Hello`, so it cannot prove the
required attachment-context follow-up. Stage 1 therefore remains partial.

## Stage 2 evidence: 12 August 2026 production audit

- One push subscription exists for Phillip's profile, so a two-device test is
  not currently possible.
- The latest 27 conversation push jobs contain seven `sent` deliveries and 20
  `skipped` deliveries, with no pending or failed job.
- Every skipped job had the explicit reason `Notification was already read`,
  which is the intended suppression when RESLU is already open and has consumed
  the private notification.
- Successful jobs completed in one attempt. The newest successful delivery was
  claimed about one second after enqueue and completed about one second later.

This proves the durable delivery worker can reach the currently subscribed
device. It does not prove a lock-screen tap opens the exact unread message, and
it cannot prove two-device unread/reconnect agreement until another device is
subscribed.

## Stage 8 accessibility candidate: 12 August 2026

Automated code contracts now protect the complete stacked conversation surface:

- every keyboard-focusable control has a high-contrast visible focus ring;
- high-frequency iPhone icon controls use a minimum 44 px touch target;
- active call, message search, new-chat and Meeting Mode layers expose dialog
  semantics, and changing call/meeting status is announced politely;
- new-chat, forwarding, group details, search, photo viewing and Meeting Mode
  contain keyboard focus, restore the launching control and close safely with
  Escape (except while Meeting Mode is recording or committing work);
- user-requested Reduce Motion removes non-essential chat, call and Meeting
  animation while preserving status text;
- critical call state and caption speaker labels no longer use 9-10 px text.

This is implementation evidence, not a live accessibility pass. Before Stage 8
can pass, exercise the production stack keyboard-only on desktop, with VoiceOver
on iPhone, with Reduce Motion enabled, with larger Dynamic Type, and by tapping
each high-frequency control on a physical phone. Confirm focus does not escape
an open dialog, status changes are understandable without color or animation,
and no required control is smaller than 44 px in either dimension.

## Stage 3 evidence: 11 August 2026 production trace

- Call: `94a19283-a72d-4c4e-8aee-d95817db57b0`
- Acknowledgement: 904 ms
- Tool selection: 1,301 ms
- Short answer to first audio: 3,499 ms
- Durable task: `d4e74476-e583-4a0f-82db-e3b487eb54a3`
- The task was claimed 1.26 seconds after creation, retained a Gateway run id,
  continued after call end, and only stopped after a separate explicit cancel.

This proves the sub-one-second acknowledgement and post-call task-continuity
parts of Stage 3. It does not prove the 250 ms interruption target because that
release did not persist output-buffer-clear timing.

## Next physical acceptance session

Run these in order and record the exact device, build/deployment, timestamps and
canonical record ids.

1. **Stage 1:** send a new camera photo and PDF from the Aria iPhone thread;
   ask a concrete follow-up about each without attaching it again.
2. **Stage 2:** put device A in airplane mode, queue a message, edit another
   conversation's draft, reconnect, and check device B plus its lock-screen
   notification. Confirm exactly one canonical turn and job.
3. **Stage 3:** ask a contextual question, interrupt real audible output,
   change subject, consult Marco, create a durable task, end by voice and confirm
   that the task continues. Save the interruption-to-clear metric.
4. **Stage 4:** keep the same conversation and call alive while navigating the
   desktop dashboard; verify the iPhone sticky header/call action at the newest
   message.

Do not promote a **PARTIAL** row to **PASS** unless every requirement in its
roadmap stage gate has direct live evidence.
