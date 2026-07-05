import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { getCategories, getProfiles } from "@/lib/reference-data";
import { Header } from "@/components/layout/Header";
import { CategorySettings } from "@/components/settings/CategorySettings";
import { TeamSettings } from "@/components/settings/TeamSettings";
import { IntegrationStatus } from "@/components/settings/IntegrationStatus";
import { QuickLinks } from "@/components/settings/QuickLinks";
import { SystemHealth } from "@/components/settings/SystemHealth";

/**
 * Settings — category management, team roster + role editing (both
 * admin-only, enforced server-side in the respective API routes), and
 * read-only integration status.
 *
 * Week 4: Team section gained real role editing (was a static list) —
 * see components/settings/TeamSettings.tsx + PATCH /api/profiles/[id].
 * Integrations section gained real green/grey status dots computed
 * from server-side env presence (was a static paragraph) — see
 * components/settings/IntegrationStatus.tsx. Booleans are computed
 * here, server-side, from process.env — never by exposing the env
 * vars themselves to the client.
 */
export default async function SettingsPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  // Phase 14A caching: both are stable reference data re-queried on
  // nearly every page in the app — see lib/reference-data.ts. This is
  // also the ONE page where a mutation to either can happen (category
  // create/edit/delete, role change), so its own forms call
  // invalidateCategoriesCache()/invalidateProfilesCache() from their
  // API routes — see app/api/categories/route.ts, app/api/categories/[id]/route.ts,
  // app/api/profiles/[id]/route.ts.
  const [categories, team] = await Promise.all([getCategories(), getProfiles()]);

  const mondayConfigured = Boolean(process.env.MONDAY_API_TOKEN);
  const gmailConfigured = Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.ARIA_GMAIL_REFRESH_TOKEN
  );

  // Phase 14A error visibility (BUILD-SPEC.md Phase 14 "admin Settings
  // section 'System health'") — admin-only, last 50 app_errors rows
  // (migration 022_perf_indexes.sql), most recent first. Queried
  // directly here rather than via a client fetch (same server-rendered
  // pattern as IntegrationStatus above) since it's a simple read-only
  // admin list with no interactivity. isAdmin gates the section
  // entirely — non-admins never even trigger this query.
  let recentErrors: {
    id: string;
    where_at: string;
    message: string;
    stack: string | null;
    created_at: string;
  }[] = [];
  if (isAdmin) {
    const { data } = await supabase
      .from("app_errors")
      .select("id,where_at,message,stack,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    recentErrors = data ?? [];
  }

  return (
    <>
      <Header title="Settings" />
      <main className="flex-1 space-y-12 px-8 py-8">
        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Categories</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Item codes are generated from these prefixes (e.g. TW-01). Prefixes
            can&apos;t be changed once created, since existing item codes depend
            on them.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <CategorySettings
            initialCategories={categories}
            canEdit={isAdmin}
          />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Team</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Financial data (trade price, markup, client price) is admin-only,
            enforced by the API regardless of what the screen shows.
            {!isAdmin && " Only admins can change roles."}
          </p>
          <TeamSettings
            initialTeam={team}
            canEdit={isAdmin}
            currentUserId={info?.userId ?? ""}
          />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Integrations</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Monday.com procurement sync and the Gmail team digest are configured
            with credentials in <code>.env.local</code> (or the Vercel project&apos;s
            environment variables in production). They stay dormant until those
            values are supplied — this list only reflects whether the app can see
            them, not whether the credentials are valid.
          </p>
          <IntegrationStatus
            mondayConfigured={mondayConfigured}
            gmailConfigured={gmailConfigured}
          />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Directory</h2>
          <p className="mb-3 text-body text-charcoal/70">
            External services that run the RESLU stack.
          </p>
          <QuickLinks />
        </section>

        {isAdmin && (
          <section>
            <h2 className="mb-1 text-subhead text-nearblack">System health</h2>
            <SystemHealth errors={recentErrors} />
          </section>
        )}
      </main>
    </>
  );
}
