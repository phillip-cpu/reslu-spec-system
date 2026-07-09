# RESLU lead flow · card package

Built to RESLU-Card-Design-Spec.md and aligned to the Client Journey guide (Stages 01-02).

## Files

- `visit-confirmation.html` — sent within 24 hours of the first conversation (from aria@reslu.com.au), confirming the Studio Visit at 219 Sturt Street. Tables + inline styles, 560px, email-safe.
- `visit-reminder.html` — sent 48 hours before the visit. Carries the questionnaire link (`{{brief_link}}`) per the journey guide.
- `project-brief.html` — the pre-visit questionnaire. Questions per Stage 02: what they are hoping to build, a space they love, materials they are drawn to, what the home should feel like, three must-haves, what they are bringing. Budget deliberately excluded (surfaced in the studio). Typed answers render in the blue pen (Caveat, #274690); letterhead flips to "THE {LAST NAME} RESIDENCE" as they type; pen date stamps automatically. Print button / Ctrl+P gives the meeting-day copy.

## Merge placeholders (emails)

`{{first_name}}` `{{visit_date}}` `{{visit_time}}` `{{phillip_phone}}` `{{brief_link}}`
Dates numeric in pen values ("14.7.26"), times as "10:00am".

## Wiring notes

- On send, the production fold sequence plays per RESLU-Paper-Animation-Brief: the begin-fold.mp4 film scales over the sheet (FV geometry constants), feathered into the bone page, clip-path set on the video element for Safari. Once the paper is at rest the emboss appears and the pen writes "The {Name} Residence · on file · {date}" character by character, then the thank-you settles in. Falls back to a CSS letter-fold if the video isn't buffered within 1.4s, and collapses timings under prefers-reduced-motion. The video preloads on first field focus.
- The submit handler intercepts the post — wire your endpoint inside the marked block in the script (a `fetch` example is commented there). Field names: first_name, last_name, hoping, favourite_spaces, materials, feel, must_1..3, bringing.
- On submission, log to the Monday.com lead card per the journey guide, and print the completed brief for the table.
- Assets hotlink from reslu.com.au (logo + email-packet.jpg); nothing to upload.
- Caveat and Cormorant Garamond load from Google Fonts; email fallback stacks are in place for clients that block them.
