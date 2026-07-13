import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { computeSpecHealth } from "@/lib/health";
import { Header } from "@/components/layout/Header";
import { MiniHealthCard } from "@/components/health/MiniHealthCard";
import { ChannelsCard } from "@/components/health/ChannelsCard";
import { SpecHealthCard } from "@/components/health/SpecHealthCard";
import type { HealthChannel, HealthDiagnostic, HealthHeartbeat } from "@/types/health-push";

/**
 * /health — Health + web push round (r26), BUILD-SPEC.md item 4.
 *
 * Admin-only, same server-component gating shape as /leads
 * (app/(dashboard)/leads/page.tsx) — this is operational/infrastructure
 * data (mini uptime, WhatsApp bridge session state, cron health), not
 * client-facing work, but not something every team member needs either;
 * gated the same way the pre-existing Settings "System health" section
 * already is (isAdmin-only). Every /api/health/* route independently
 * re-checks admin (or the mini's own Bearer auth) too — this page-level
 * gate is a UX nicety, not the enforcement boundary, same discipline as
 * every other admin-gated page in this schema.
 *
 * Server component fetches everything in one pass (service-role client
 * — same "read-heavy admin dashboard, no RLS-scoping needed" posture as
 * the Settings page's own direct app_settings/app_errors reads); the
 * only client-side pieces are the ticking heartbeat age
 * (MiniHealthCard) and the diagnostics button's own fetch
 * (DiagnosticsButton, nested inside MiniHealthCard).
 */
export default async function HealthPage() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  if (!isAdmin) {
    return (
      <>
        <Header title="Health" />
        <main className="flex-1 px-8 py-16">
          <div className="mx-auto max-w-md border border-[#dcd6cc] bg-offwhite p-8 text-center">
            <p className="label-caps mb-2">Restricted</p>
            <p className="text-body text-charcoal/70">
              This area is restricted. Ask an admin if you need access to system health.
            </p>
          </div>
        </main>
      </>
    );
  }

  const service = createServiceRoleClient();

  const [{ data: heartbeat }, { data: channels }, { data: latestDiagnostic }, specHealth] = await Promise.all([
    service.from("health_heartbeats").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    service.from("health_channels").select("*").order("channel", { ascending: true }),
    service.from("health_diagnostics").select("*").order("requested_at", { ascending: false }).limit(1).maybeSingle(),
    computeSpecHealth(service),
  ]);

  return (
    <>
      <Header title="Health" subtitle="Mini uptime, channel status, and Spec system cron health." />
      <main className="flex-1 space-y-6 px-8 py-8">
        <MiniHealthCard heartbeat={(heartbeat as HealthHeartbeat) ?? null} latestDiagnostic={(latestDiagnostic as HealthDiagnostic) ?? null} />
        <ChannelsCard channels={(channels as HealthChannel[]) ?? []} />
        <SpecHealthCard summary={specHealth} />
      </main>
    </>
  );
}
