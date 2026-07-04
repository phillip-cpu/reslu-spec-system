import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { CategorySettings } from "@/components/settings/CategorySettings";
import { TeamSettings } from "@/components/settings/TeamSettings";
import { IntegrationStatus } from "@/components/settings/IntegrationStatus";
import { QuickLinks } from "@/components/settings/QuickLinks";
import type { Category, Profile } from "@/types";

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

  const [{ data: categories }, { data: team }] = await Promise.all([
    supabase.from("categories").select("*").order("sort_order"),
    supabase.from("profiles").select("*").order("full_name"),
  ]);

  const mondayConfigured = Boolean(process.env.MONDAY_API_TOKEN);
  const gmailConfigured = Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.ARIA_GMAIL_REFRESH_TOKEN
  );

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
            initialCategories={(categories ?? []) as Category[]}
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
            initialTeam={(team ?? []) as Profile[]}
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
      </main>
    </>
  );
}
