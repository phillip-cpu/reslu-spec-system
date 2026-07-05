import type { PortalWhatsNext } from "@/app/portal/types";

/**
 * "What's next" block (BUILD-SPEC.md §"Phase 11 additions — confirmed
 * by Phillip" point 3) — sits at the TOP of the portal, above the
 * sticky nav's sections proper. Derived-only, no pricing, no contact
 * details — trade company names only (never a phone/email). Renders
 * nothing if there is genuinely nothing scheduled either week (a new
 * project with no phases yet, or between confirmed phases).
 */
export function WhatsNextBlock({ whatsNext }: { whatsNext: PortalWhatsNext }) {
  const { this_week, next_week } = whatsNext;
  const hasThisWeek = this_week.phase_names.length > 0;
  const hasNextWeek = next_week.phase_names.length > 0;

  if (!hasThisWeek && !hasNextWeek) return null;

  return (
    <div className="border-b border-[#dcd6cc] bg-offwhite px-6 py-6">
      <div className="mx-auto max-w-4xl">
        <p className="label-caps mb-3 !text-sand">What&apos;s next</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <WeekCard label="This week" phaseNames={this_week.phase_names} trades={this_week.trade_companies} />
          <WeekCard label="Next week" phaseNames={next_week.phase_names} trades={next_week.trade_companies} />
        </div>
      </div>
    </div>
  );
}

function WeekCard({
  label,
  phaseNames,
  trades,
}: {
  label: string;
  phaseNames: string[];
  trades: string[];
}) {
  return (
    <div className="border border-[#dcd6cc] bg-cream p-4">
      <p className="text-subhead text-nearblack">{label}</p>
      {phaseNames.length === 0 ? (
        <p className="mt-1 text-body text-charcoal/50">Nothing scheduled.</p>
      ) : (
        <>
          <p className="mt-1 text-body text-charcoal/80">{phaseNames.join(", ")}</p>
          {trades.length > 0 && (
            <p className="mt-2 text-caption text-charcoal/50">On site: {trades.join(", ")}</p>
          )}
        </>
      )}
    </div>
  );
}
