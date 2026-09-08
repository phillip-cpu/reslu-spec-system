# Agent chat rebuild — September 2026

Scope: desktop and iPhone readability and interaction, with a targeted correction to short-follow-up handling. This is not evidence that the production agent runtime or model quality has been repaired.

## Implemented

- Wider reading column and 17px chat text; structured headings, lists, tables and literal code blocks. Raw HTML is never rendered, and executable/protocol-relative links are rejected.
- Collapsible conversation list, automatically collapsed in compact desktop workspaces; expanded floating messenger and removal of the redundant toolbar on the Messages page.
- Full-screen answer reader and private PDF preview with an original-document fallback. Reader isolates background interaction, traps keyboard focus and restores it on close.
- Activity details open separately from history. Live queued/processing states have elapsed time; absent progress is labelled as delayed, not falsely completed. Interrupted agent responses are distinguished from group updates.
- Reachable phone composer, growing multiline input, no accidental Enter-send during IME composition or on touch devices. Desktop retains Enter-send / Shift-Enter newline.
- Feedback tucked behind one control; Copy, full-screen reading and message actions remain discoverable. Date separators no longer stack over replies.
- Bridge treats short approvals/corrections as contextual follow-ups requiring reasoning. PDF instructions name the actual staged-PDF tool. Completion-envelope instructions are no longer contradicted by a plain-text-only instruction.
- Response instructions distinguish verified results, denied actions and the smallest legitimate next step. The OpenAI Docs skill informed this explicit outcome/constraint framing: [official guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5). No model migration or permission expansion was made.

## Verification and limitations

- Python bridge suite: 84 tests passed, including follow-ups, PDF invocation instructions, untrusted-data boundaries and completion-envelope assertions.
- Chat/conversation suite: 188 of 191 tests passed. All 27 focused renderer, timeline, mobile-layout, activity and accessibility checks passed.
- Three pre-existing source-contract mismatches were confirmed against the starting revision: consultation expects `reply` instead of `visible_reply`; prompt-boundary test expects `bounded_json_data` instead of `bounded_transcript_json`; voice cancellation expects `cancel_agent_conversation_jobs` instead of `cancel_realtime_voice_agent_jobs`. These unrelated contracts were not changed.
- TypeScript and targeted ESLint passed during implementation. A final verification pass is required after any further changes.
- Browser-control service repeatedly timed out. A synthetic-data-only Next preview was attempted outside the repository; visual review and physical iPhone testing are NOT verified. No production chats or financial records were changed by these checks.
- Production build was attempted but did not finish during the local verification window. Do not treat source tests as a successful production build.
- This branch is not deployed. Website deployment and the Mac mini bridge/plugin rollout are separate operations. The earlier PDF fix on the website does not prove the Mac mini loaded it.

## Release gate

1. Finish a clean production build and review the real interface at desktop widths and at 390px/430px phone widths, including long tables and attachment filenames.
2. Check list show/hide, search, draft persistence, send/retry, jump-to-latest, activity, feedback, full-screen text/PDF, Escape/focus restoration and existing voice controls.
3. Test a physical iPhone with its keyboard open, safe areas, text scaling, PDF fallback and scrolling back through a long history. Do not assert physical-device acceptance from a desktop-sized fixture.
4. Deploy the website through the normal reviewed workflow. Update the actual Mac mini checkout, bridge and PDF plugin separately; verify a harmless PDF-reading request and a contextual follow-up there.
5. Investigate the live finance capability denial separately. Do not loosen attachment restrictions or claim that a repeated approval repairs an unavailable tool.
