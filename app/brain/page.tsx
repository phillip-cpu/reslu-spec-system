import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { BrainVisualizer } from "@/components/brain/BrainVisualizer";

/**
 * /brain — RESLU Second Brain, Step 13 (docs/RESLU-second-brain-build-brief.md).
 *
 * Sits outside the (dashboard) route group deliberately, same as
 * /portal/[token] and /trade/[token] — this is a full-bleed canvas
 * page, not a dashboard-shell page — but unlike those two (public,
 * token-authenticated), this shows real internal project/item/email
 * names, so it needs a real team session, checked here explicitly
 * since being outside (dashboard) means it doesn't inherit whatever
 * that group's own layout does.
 */
export default async function BrainPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  return <BrainVisualizer />;
}
