# API additions — Week 8B (portal expansion + native e-signature)

**This file merges into `docs/API.md`.** It is a separate file this round
because `docs/API.md` is owned by another agent working the same tree
concurrently this week — do not duplicate content by hand-merging both
files; fold this one in (or have it folded in) the next time `docs/API.md`
is next touched.

Written in the same format and auth-tier vocabulary as `docs/API.md`:
**session**, **session (financial fields admin-only)**, **admin**,
**portal-token**. See that file's "Auth tiers used below" section for the
full definitions — repeated here only where a tier's meaning is
Week-8B-specific.

---

## Portal reads (existing route, extended)

### GET /portal/[token] (page, not an API route)
Auth: portal-token. No longer just the FF&E schedule — now renders every
sectioned area described below in one server-rendered page: Schedule &
approvals (unchanged), Documents, Contracts & signatures, Variations,
Progress photos, Updates. Still carries no item pricing; the one
deliberate exception is variation cost, shown **inc GST only**.

---

## Variations — portal response

### POST /api/portal/[token]/variation/[id]/respond
Auth: portal-token. Body: `{ response: "approved" | "declined", note?: string }`.
Response: `{ variation: { id, var_number, var_date, description, cost_inc_gst, client_response, client_response_note, client_responded_at } }`.
Verifies the variation belongs to the token's project AND has
`share_to_portal = true` before accepting a response (same ownership
discipline as the existing item approve/flag route). Rate-limited.
Records a digest-queue entry via `lib/gmail/digest.ts`'s
`recordPortalAction()` (never blocks the response). `cost_inc_gst` is
computed server-side from `cost_ex_gst * 1.10` — the client never
supplies or sees `cost_ex_gst` directly.

---

## Native e-signature

### GET /api/portal/[token]/sign/[requestId]
Auth: portal-token. Response: `{ target: PortalSigningTarget, consentStatement }`.
`target.document_url` is a signed URL (1hr TTL) to the underlying PDF for
`project_file` subjects, or `null` for `variation`/`sow` subjects (no
stored PDF to preview — the sign page shows a text summary instead).
Rate-limited.

### POST /api/portal/[token]/sign/[requestId]
Auth: portal-token. Body:
`{ signature_data_url: string (PNG data URL), signer_name_typed: string, consent: boolean }`.
Response: `{ status: "signed", signed_at, certificate_url }` or `{ error }`
(400/404/409/500). This is the security-critical route — implements
BUILD-SPEC.md §"Built-in digital signature" exactly:

1. Rejects unless `consent === true` and a non-empty typed name and a
   non-empty decoded PNG signature are present.
2. Verifies the `signature_requests` row belongs to the token's project
   and is still `pending` (409 if already `signed`/`void`).
3. **Recomputes `document_sha256` server-side** from the actual stored
   bytes (`lib/signatures.ts` `resolveDocumentBytes` + `sha256Hex`) —
   never trusts a client-supplied hash. For `project_file` subjects this
   downloads the real object from Storage; for `variation` subjects (no
   stored PDF) it hashes a canonical JSON snapshot of the variation's
   id/number/description/cost/date, which is what the void-on-edit
   trigger (migration 012) invalidates when the variation later changes.
4. Uploads the drawn signature PNG to the **private** `assets` bucket
   (`signatures/{projectId}/{requestId}/...-signature.png`).
5. Inserts one **append-only** `signature_events` row (see schema below)
   via the service-role client, then flips `signature_requests.status`
   to `'signed'`.
6. Best-effort (never fails the response): renders a branded
   signature-certificate PDF via React-PDF (`components/portal/SignatureCertificatePdf.tsx`),
   uploads it as a **new** object next to the original (never overwriting
   it), indexes it as a `project_files` row (`kind: 'other'`) for
   `project_file` subjects, and emails admins via `lib/gmail/send.ts` if
   Gmail is configured (no client-contact-email field exists on
   `projects` yet, so client copies aren't sent until one is added — see
   the route's inline comment).

Rate-limited tighter than reads (10/min vs the usual 30/min) since this
is the one portal route that writes durable, non-reversible evidence.

---

## Signature requests — team-side

### POST /api/signatures
Auth: session (any team member — NOT admin-only; only variation
**sharing**, below, is admin-gated). Body:
`{ project_id, subject_type: "project_file"|"variation"|"sow", subject_id }`.
Response: `{ request }` (201). Validates the subject exists and belongs
to `project_id` for `project_file`/`variation` subject types before
creating the request (no `sow` table exists in this agent's boundary —
`sow` subjects are trusted at face value here).

### GET /api/signatures?project_id=...
Auth: session. Response: `{ requests: (SignatureRequest & { evidence })[] }`
— each request's most recent `signature_events` row (signer name, signed
at) is attached inline so the client-area UI doesn't need a second
round-trip per row.

### GET /api/signatures/[id]
Auth: session. Response: `{ request, evidence, certificate_url }`.
`certificate_url` is a freshly-signed URL to the generated certificate
PDF (re-derived by listing the `signatures/{projectId}/{requestId}/`
Storage prefix — the certificate's exact filename is timestamped, not
fixed).

### PATCH /api/signatures/[id]
Auth: session. Body: `{ action: "void", reason?: string }`. Sets
`status = 'void'`, `voided_reason`, `voided_at`. This is the **manual**
half of void-on-change: `project_files` revisions are new rows (not
edits), so there's no UPDATE for a trigger to catch — the team manually
voids the old file's signature request when uploading a superseded
revision. (Variations DO auto-void via a database trigger on
`cost_ex_gst`/`description` UPDATE — see migration 012 PART 6 — no route
needed for that case.)

---

## Team-side client area

All routes below are **session** (any team member) unless noted.

### GET /api/projects/[id]/client-updates/summary
One-shot summary for the client-area page: files (with
`share_to_portal`), variations (with `share_to_portal` + client
response), signature requests, updates, photo count, and the fortnightly
cadence figure: `{ cadence: { last_published_at, days_since_last_update, stale } }`
(`stale = true` when `days_since_last_update > 14` or no update has ever
been published).

### GET/POST /api/projects/[id]/client-updates/photos
GET → `{ photos: (ProgressPhoto & { url })[] }`, newest first. POST →
multipart `{ files[] (multiple), caption?, taken_at? }`, uploads each
file sequentially into the private `assets` bucket
(`projects/{id}/progress/...`), returns `{ photos: created[], errors[] }`
(207-like partial-success shape, but responds 201 as long as at least one
file succeeded, 500 if all failed).

### PATCH/DELETE /api/projects/[id]/client-updates/photos/[photoId]
PATCH body: `{ caption?, taken_at? }`. DELETE soft-deletes
(`deleted_at`).

### GET/POST /api/projects/[id]/client-updates/posts
GET → `{ updates: PortalUpdate[] }`, ALL rows (drafts + published) for
the team draft list — not the portal's published-only feed (that's the
inline query in `app/portal/[token]/page.tsx`). POST body:
`{ title, body_richtext }` → creates a **draft** (`published_at: null`).

### PATCH/DELETE /api/projects/[id]/client-updates/posts/[postId]
PATCH body: `{ title?, body_richtext?, publish?: boolean }`.
`publish: true` sets `published_at = now()` **only if currently null**
(re-publishing doesn't reset the cadence clock); `publish: false`
un-publishes. DELETE soft-deletes.

### PATCH /api/projects/[id]/client-updates/files/[fileId]/share
Body: `{ share_to_portal: boolean }`. Team-authenticated, not admin-only
— documents aren't financial (same gating as the rest of the Documents
feature).

### PATCH /api/projects/[id]/client-updates/variations/[variationId]/share
Body: `{ share_to_portal: boolean }`. **Auth: admin.** The one
admin-gated action in this whole feature — "it exposes client pricing
decisions" (BUILD-SPEC.md). Enforced server-side (403 for non-admins
before any query runs), not merely disabled in the UI.

---

## Schema reference (migration `012_portal_expansion.sql`)

- `portal_updates(id, project_id, title, body_richtext, author_id, published_at?, created_at, updated_at, deleted_at?)`
- `progress_photos(id, project_id, storage_path, caption?, taken_at?, uploaded_by, created_at, deleted_at?)`
- `project_files.share_to_portal boolean default false` (additive)
- `variations.share_to_portal boolean default false`, `.client_response ('approved'|'declined')?`, `.client_response_note?`, `.client_responded_at?` (additive)
- `signature_requests(id, project_id, subject_type, subject_id, status, requested_by, voided_reason?, voided_at?, created_at, updated_at)`
- `signature_events(id, project_id, subject_type, subject_id, signature_request_id?, document_sha256, signer_name_typed, signature_image_path, portal_token_used, ip?, user_agent?, signed_at)` —
  **append-only**: RLS grants `authenticated` INSERT + SELECT only; there
  is no UPDATE or DELETE policy on this table at all (not even for
  `authenticated`), which is the actual enforcement mechanism. The portal
  sign route inserts via the service-role client (bypasses RLS by
  definition — this is the "INSERT via service role for portal" clause,
  not a policy naming `service_role`).
- Trigger `trg_void_signature_on_variation_change`: on `variations`
  UPDATE, if `cost_ex_gst` or `description` changed AND a
  `signature_events` row already exists for that variation, sets any
  `signed` `signature_requests` row for it to `void`.
