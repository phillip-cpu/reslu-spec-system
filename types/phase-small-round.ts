// ============================================================
// RESLU Spec System — "Small round" LOCAL types (6 July 2026)
// Image options modal picker, Add-to-calendar, item_code editing API.
//
// Same isolation convention every phase-N.ts file in this directory
// already follows (see phase-12a-b.ts's own header comment for the
// full rationale): types/index.ts is a protected file for this round
// (per the task brief's DO-NOT-TOUCH list), so any shape needed only
// by this round's own files lives here instead and is imported
// directly from this module rather than added to the shared file.
// ============================================================

import type { Profile } from "@/types";

// ------------------------------------------------------------
// Invitee picker (calendar attendees) — components/leads/LeadDetailPanel.tsx
// and components/client-area/ClientEventsPanel.tsx both need a
// lightweight "pick one or more team emails" control. Backed by the
// new GET /api/profiles route (see that route's doc comment for why
// no such listing route existed before this round).
// ------------------------------------------------------------

export type InviteeOption = Pick<Profile, "id" | "full_name" | "email">;

export interface ProfilesListResponse {
  profiles: InviteeOption[];
}

// ------------------------------------------------------------
// Item code editing — PATCH /api/items/[id] gains `item_code` as a
// whitelisted, validated field (see that route's own doc comment for
// the full "codes are sticky, never renumbered" rationale). This type
// documents the accepted shape for whoever wires up the edit UI in
// SpecRegister.tsx per docs/HANDOFF-code-editing.md — SpecRegister.tsx
// itself is out of this round's edit boundary (protected file), so the
// actual input/button never got built; this type is ready for that
// follow-up to import as-is.
// ------------------------------------------------------------

/** Body accepted by PATCH /api/items/[id] when editing just the code. Same route, same whitelist mechanism as every other editable item field — this is not a new endpoint. */
export interface PatchItemCodeInput {
  item_code: string;
}

/** ^[A-Z]{2,3}-\d{1,3}$ — e.g. "TW-01", "SW-4", "LI-104". Exported so the eventual SpecRegister input can validate client-side with the exact same pattern the server enforces, rather than a hand-copied regex drifting out of sync. */
export const ITEM_CODE_PATTERN = /^[A-Z]{2,3}-\d{1,3}$/;
