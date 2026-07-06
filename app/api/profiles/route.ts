import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getProfiles } from "@/lib/reference-data";
import type { ProfilesListResponse } from "@/types/phase-small-round";

/**
 * GET /api/profiles
 * Auth: session (any signed-in team member — same "team_all" RLS/API
 * gate every other reference-data read in this app uses).
 *
 * Until this round, there was no standalone listing route for the team
 * roster — every existing caller either queried `profiles` inline
 * (app/api/office/route.ts's GET) or went through
 * lib/reference-data.ts's cached getProfiles() from server components
 * directly. This round's invitee picker (calendar attendees, "Add to
 * calendar ▾" on the lead detail panel + client event rows) is a
 * client component and needs its own fetchable endpoint, so this adds
 * the thin route rather than duplicating another inline query.
 *
 * Response is deliberately narrowed to { id, full_name, email } — role/
 * avatar_url/timestamps aren't needed for an attendee picker and this
 * keeps the payload small. Reuses the same 5-minute cache
 * (PROFILES_CACHE_TAG) as every other profiles read in the app, so a
 * just-added team member can take up to that window to appear here
 * (same staleness bound Settings' Team section already accepts).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const profiles = await getProfiles();
  const payload: ProfilesListResponse = {
    profiles: profiles.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email })),
  };
  return NextResponse.json(payload);
}
