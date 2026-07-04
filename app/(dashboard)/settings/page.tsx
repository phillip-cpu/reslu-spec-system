import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { CategorySettings } from "@/components/settings/CategorySettings";
import type { Category, Profile } from "@/types";

/**
 * Settings — category management (admin-only, enforced in the API) and
 * the team roster. Integrations (Monday, Gmail) are configured via
 * environment variables, not here.
 */
export default async function SettingsPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  const [{ data: categories }, { data: team }] = await Promise.all([
    supabase.from("categories").select("*").order("sort_order"),
    supabase.from("profiles").select("*").order("full_name"),
  ]);

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
            All team members have equal access to projects. The admin role only
            gates settings changes.
          </p>
          <ul className="max-w-lg divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
            {(team ?? []).map((p: Profile) => (
              <li key={p.id} className="flex items-center justify-between px-4 py-3">
                <div>
                  <p className="text-body text-nearblack">{p.full_name}</p>
                  <p className="text-caption text-charcoal/50">{p.email}</p>
                </div>
                <span className="label-caps">{p.role}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-caption text-charcoal/50">
            Add or remove team members in the Supabase dashboard
            (Authentication → Users). New users get a profile automatically.
          </p>
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Integrations</h2>
          <p className="text-body text-charcoal/60">
            Monday.com procurement sync and the Gmail client-action digest are
            configured with credentials in <code>.env.local</code>. They stay
            dormant until those values are supplied.
          </p>
        </section>
      </main>
    </>
  );
}
