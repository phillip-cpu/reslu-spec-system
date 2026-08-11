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
| 2. Trustworthy everyday messaging | **PARTIAL** | Migrations 093-098 and matching verifiers were applied successfully; exactly-once, drafts, unread, push, preferences, search and quoted-reply paths have focused automated coverage. | Complete the two-device online/offline/reconnect matrix, receive a real lock-screen message notification, open its exact unread message, and restore text plus attachment drafts in their original conversations. |
| 3. Natural low-latency voice | **PARTIAL** | Latest driving call acknowledged in 904 ms, began its short spoken result in 3,499 ms and started a Gateway-backed durable task that continued after hang-up. | Deploy the interruption metric patch, then prove output clears within 250 ms after genuine barge-in. Complete the full contextual-question, interruption, subject-change, cross-agent consultation and voice-ended call gate without stale audio or duplicate canonical output. |
| 4. Native-feeling mobile and persistent desktop chat | **PARTIAL** | Persistent desktop messenger and mini-player are merged on `main`; mobile has a sticky call action and newest-message layout. | In an authenticated production desktop session, keep one typed turn and one call alive while navigating project, lead and office routes. On iPhone, prove newest message and call action are reachable without scrolling history. |
| 5. iPhone background and in-car continuity | **PENDING** | Native shell candidate exists as draft PR #47. Browser foreground recovery is already delivered. | Install/activate Xcode, compile the native target and pass a physical-device call across screen lock, audio-route change and Wi-Fi/mobile handoff. |
| 6. Meeting Mode and intelligent filing | **PENDING** | Staged Meeting Mode implementation is committed locally with migration 103, silent capture, checkpointing, review, explicit filing and audit safeguards; automated checks pass. | Publish and review the PR, apply migration 103 and its verifier, update/restart the Mac MCP runtime, then pass one lead consultation, one active-project meeting and one ambiguous-destination meeting. |
| 7. RESLU team intelligence | **PENDING** | Canonical Aria/Marco identities and one-agent consultation boundary already exist. | Pass one real cross-domain collaboration scenario with correct lanes, one owner, no duplicate action and an auditable record. |
| 8. Hardening and no-WhatsApp pilot | **PENDING** | Production has RLS verifiers, bounded voice/Gateway metadata and several reliability diagnostics. | Complete security, retention, accessibility, poor-network and long-history matrices, then complete a two-week agreed-workflow pilot without opening WhatsApp and without an unresolved critical defect. |

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
