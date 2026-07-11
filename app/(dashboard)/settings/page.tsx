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
import { ExportPresetSettings } from "@/components/settings/ExportPresetSettings";
import { BankDetailsSettings } from "@/components/settings/BankDetailsSettings";
import { CpdDefaultsSettings } from "@/components/settings/CpdDefaultsSettings";
import { EmailSignaturesSettings } from "@/components/settings/EmailSignaturesSettings";
import { getSignaturePeople } from "@/lib/email-signatures";
import { FALLBACK_PHASE_TEMPLATE, FALLBACK_PHASE_TASK_TEMPLATES } from "@/lib/phase-template";
import { FALLBACK_DESIGN_TASK_TEMPLATES } from "@/lib/design-task-templates";
import { FALLBACK_EXPORT_PRESETS } from "@/lib/export-presets";
import { BANK_DETAILS_SETTINGS_KEY } from "@/lib/bank-details";
import { FALLBACK_CPD_DEFAULTS } from "@/lib/cpd";
import { DESIGN_PHASE_TEMPLATE } from "@/types/phase-12b";
import type { AppSettingsPhaseTemplateRow } from "@/types/phase-fix-a";
import type { PhaseTaskTemplatesMap } from "@/types/board-cockpit";
import type { DesignTaskTemplatesMap } from "@/types/round-c";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { InvoiceBankDetails } from "@/types/client-invoices";
import type { CpdDefaults } from "@/types/cpd";

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

  // Email signatures round (r22) — static, JSON-backed list (see
  // lib/email-signatures.ts header comment for why: profiles has no
  // title/phone columns). No DB round-trip needed, unlike every other
  // section's app_settings read above.
  const signaturePeople = getSignaturePeople();

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
  // Board v3 — Monday parity round: falls back to the real 13-stage
  // checklist (FALLBACK_PHASE_TASK_TEMPLATES) instead of `{}`, same as
  // GET /api/settings/phase-task-templates's own updated fallback.
  const phaseTaskTemplates =
    (phaseTaskTemplatesRow?.value as PhaseTaskTemplatesMap | undefined) ?? FALLBACK_PHASE_TASK_TEMPLATES;

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

  // "Export + board batch" round (7 July 2026) — trade export presets
  // (app_settings 'export_presets'), read directly here same as the
  // other app_settings-backed editors above (server component, no
  // round-trip through its own GET route needed).
  const { data: exportPresetsRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "export_presets")
    .maybeSingle();
  const exportPresets = (exportPresetsRow?.value as ExportPresetRow[] | undefined) ?? FALLBACK_EXPORT_PRESETS;

  // Client invoicing round (BUILD-SPEC.md "Phillip's ideas list — 6
  // July 2026" item 5) — bank transfer details shown on every client
  // invoice PDF/email (app_settings 'invoice_bank_details'), read
  // directly here same as every other app_settings-backed editor
  // above. Deliberately NO fallback constant — see
  // lib/bank-details.ts's header comment for why a bank account number
  // must never be invented; this section is admin-only (isAdmin gates
  // the whole section below, not just editability), unlike the
  // team-visible sections above it, since bank details are financial
  // data (this round's brief: "admin-gate all routes (financial)").
  let bankDetails: InvoiceBankDetails | null = null;
  if (isAdmin) {
    const { data: bankDetailsRow } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", BANK_DETAILS_SETTINGS_KEY)
      .maybeSingle();
    bankDetails = (bankDetailsRow?.value as InvoiceBankDetails | undefined) ?? null;
  }
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

  // CPD tracker round — annual target + licence-year start month
  // (app_settings 'cpd_defaults'), read directly here same as every
  // other app_settings-backed editor above. Team-visible READ (every
  // team member's /cpd page needs these), admin-only EDIT — this
  // section itself is NOT gated behind `isAdmin` the way bank details
  // is (CPD targets aren't financial data), only the form's Save button
  // is (canEdit={isAdmin}, same disabled-inputs shape as every other
  // team-visible-read/admin-write section on this page).
  const { data: cpdDefaultsRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "cpd_defaults")
    .maybeSingle();
  const cpdDefaults = (cpdDefaultsRow?.value as CpdDefaults | undefined) ?? FALLBACK_CPD_DEFAULTS;

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
          {/* Order-by engine round (8 July 2026) — COPY ONLY. Renamed
              from "Export presets" to "Trade mappings": these rows are
              now the single source both the FF&E schedule export
              dialog AND the Pricing & Procurement ORDER BY column read
              from (lib/order-by.ts derives an item's order date by
              matching its category against a preset's prefixes[], then
              that preset's contact_categories[] against a booked
              trade's contact). Component name/props/data shape below
              (ExportPresetSettings, app_settings key 'export_presets')
              are UNCHANGED — see that component's own header comment. */}
          <h2 className="mb-1 text-subhead text-nearblack">Trade mappings</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Named trade mappings — each pairs the item categories a trade
            covers with that trade&apos;s Address Book contact categories.
            Used two ways: as quick-pick presets in the FF&amp;E schedule
            export dialog (each ticks a set of categories in one click), and
            by the order-by engine to work out an item&apos;s ORDER BY date from
            that trade&apos;s booked works date. Edit the name, the item
            categories, or the contact categories on any row, or add a new
            mapping below.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <ExportPresetSettings initialPresets={exportPresets} categories={categories} canEdit={isAdmin} />
        </section>

        <section>
          {/* CPD tracker round — BUILD-SPEC.md "CPD point tracker".
              Studio-wide annual target + licence-year start month;
              per-user override is explicitly out of scope for v1 (see
              lib/cpd.ts's FALLBACK_CPD_DEFAULTS doc comment). */}
          <h2 className="mb-1 text-subhead text-nearblack">CPD</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Studio-wide annual CPD point target and licence-year start month, used by every
            team member&apos;s <a href="/cpd" className="underline hover:text-nearblack">CPD tracker</a> page
            and the My Work pace nudge. Applies to everyone — there is no per-person target in
            this version.
            {!isAdmin && " Only admins can make changes."}
          </p>
          <CpdDefaultsSettings initialDefaults={cpdDefaults} canEdit={isAdmin} />
        </section>

        {/* Client invoicing round (BUILD-SPEC.md "Phillip's ideas list
            — 6 July 2026" item 5) — admin-only section (the whole
            section, not just the form, is gated: a non-admin sees
            neither the current values nor a blank form, since even
            "is a bank account configured yet" is financial information
            this codebase doesn't surface to non-admins elsewhere
            either). Stripe row is read-only status (same pattern as
            Integrations below) — the payment link itself is created
            per-invoice from the Client invoices composer, never here. */}
        {isAdmin && (
          <section>
            <h2 className="mb-1 text-subhead text-nearblack">Client invoicing — bank details</h2>
            <p className="mb-4 text-body text-charcoal/60">
              Shown on every client tax invoice PDF/email as the standard direct-transfer
              payment method. MYOB stays the ledger of record — invoices raised here are
              entered into MYOB manually (no API sync in phase 1).
            </p>
            <BankDetailsSettings initialBankDetails={bankDetails} canEdit={isAdmin} />
            <p className="mt-3 text-caption text-charcoal/50">
              Stripe payment links:{" "}
              <span className={stripeConfigured ? "text-charcoal" : "text-charcoal/40"}>
                {stripeConfigured
                  ? "configured — “Create payment link” is available per invoice."
                  : "not configured — set STRIPE_SECRET_KEY to enable the optional “Create payment link” action (small invoices only; bank transfer remains the standard method)."}
              </span>
            </p>
          </section>
        )}

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

        {/* Email signatures round (r22) — BUILD-SPEC.md "Email
            signatures page". Team-visible, no admin gate (item 5: "no
            secrets, visible to all users") — every team member can copy
            their own signature or download their Mac installer here.
            Design is locked (item 3); the markup itself lives in
            lib/email-signatures.ts, extracted verbatim from
            emails/signatures/reference-signature-phillip.html between
            its SIGNATURE STARTS/ENDS comments. People, titles and phones
            are sourced from emails/signatures/people.json — the
            profiles table (migrations 001/003) has no title or phone
            columns, so per item 5 no migration was added this round. */}
        <section>
          <h2 className="mb-1 text-subhead text-nearblack">Email signatures</h2>
          <p className="mb-4 text-body text-charcoal/60">
            Copy your signature straight into Gmail or Apple Mail, or download a Mac installer
            script that sets it up for you. Everyone&apos;s title and phone number come from{" "}
            <code>emails/signatures/people.json</code> for now, so TBC values are shown as-is until
            they&apos;re filled in.
          </p>
          <EmailSignaturesSettings people={signaturePeople} />
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
