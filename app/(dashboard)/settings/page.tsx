import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { getCategories, getProfiles } from "@/lib/reference-data";
import { Header } from "@/components/layout/Header";
import { CategorySettings } from "@/components/settings/CategorySettings";
import { TeamSettings } from "@/components/settings/TeamSettings";
import { IntegrationStatus } from "@/components/settings/IntegrationStatus";
import { QuickLinks } from "@/components/settings/QuickLinks";
import { SystemHealth } from "@/components/settings/SystemHealth";
import { PhaseTemplateSettings } from "@/components/settings/PhaseTemplateSettings";
import { PhaseTaskTemplateSettings } from "@/components/settings/PhaseTaskTemplateSettings";
import { DesignTaskTemplateSettings } from "@/components/settings/DesignTaskTemplateSettings";
import { FALLBACK_PHASE_TEMPLATE } from "@/lib/phase-template";
import { FALLBACK_DESIGN_TASK_TEMPLATES } from "@/lib/design-task-templates";
import { DESIGN_PHASE_TEMPLATE } from "@/types/phase-12b";
import type { AppSettingsPhaseTemplateRow } from "@/types/phase-fix-a";
import type { PhaseTaskTemplatesMap } from "@/types/board-cockpit";
import type { DesignTaskTemplatesMap } from "@/types/round-c";

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

  // Fix Round A — Pre-populated phases (BUILD-SPEC.md "Pre-populated
  // phases"): the editable seed template both the Timeline and Board
  // Grouped-list view seed schedule_phases from on first visit — see
  // lib/phase-seed.ts. Read directly here (server component), same
  // pattern as recentErrors below, rather than round-tripping through
  // GET /api/settings/phase-template.
  const { data: phaseTemplateRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "phase_template")
    .maybeSingle();
  const phaseTemplate =
    (phaseTemplateRow?.value as AppSettingsPhaseTemplateRow[] | undefined) ?? FALLBACK_PHASE_TEMPLATE;

  // Board cockpit round — phase task templates (app_settings
  // 'phase_task_templates'), read directly here same as phase_template
  // right above (server component, no round-trip through its own GET
  // route needed).
  const { data: phaseTaskTemplatesRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "phase_task_templates")
    .maybeSingle();
  const phaseTaskTemplates = (phaseTaskTemplatesRow?.value as PhaseTaskTemplatesMap | undefined) ?? {};

  // "Two from Phillip — 7 July 2026" item 2 — design task templates
  // (app_settings 'design_task_templates'), read directly here same as
  // phase_task_templates right above (server component, no round-trip
  // through its own GET route needed). Falls back to
  // lib/design-task-templates.ts's FALLBACK_DESIGN_TASK_TEMPLATES
  // (code-level fallback, not a migration seed — see that file's header
  // comment) rather than an empty object, so Settings shows the
  // extracted starting-point checklist even before anyone has ever
  // saved this key.
  const { data: designTaskTemplatesRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "design_task_templates")
    .maybeSingle();
  const designTaskTemplates =
    (designTaskTemplatesRow?.value as DesignTaskTemplatesMap | undefined) ?? FALLBACK_DESIGN_TASK_TEMPLATES;

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
          <h2 className="mb-1 text-subhead text-nearblack">Default phase template</h2>
          <p className="mb-4 text-body text-charcoal/60">
            New projects (and any project whose Timeline or Board hasn&apos;t been
            opened yet) seed their phases from this list on first visit. Exactly
            one phase must be the umbrella (Site Setup) phase.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <PhaseTemplateSettings initialTemplate={phaseTemplate} canEdit={isAdmin} />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Phase task templates</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Optional checklist of board cards seeded into each phase&apos;s Grouped-list
            section the next time a new project&apos;s phases are seeded (from the
            default phase template above). Editing here never touches an
            already-seeded project.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <PhaseTaskTemplateSettings
            phaseNames={phaseTemplate.map((p) => p.name)}
            initialTemplates={phaseTaskTemplates}
            canEdit={isAdmin}
          />
        </section>

        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Design task templates</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Starting-point checklist seeded into each Design Framework phase the
            next time a new project&apos;s Design tab is first opened. Extracted
            from the Monday design board as editable defaults, not a fixed
            checklist — edit freely. Editing here never touches an
            already-seeded project.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <DesignTaskTemplateSettings
            phaseNames={DESIGN_PHASE_TEMPLATE}
            initialTemplates={designTaskTemplates}
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
