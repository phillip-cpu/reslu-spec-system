import { PortalSection } from "./PortalSection";
import { computeGanttGrid, isNewMonth, monthLabel, phaseGridPosition } from "@/lib/gantt";
import type { PortalPhase } from "@/types";

const COLOR_SWATCH: Record<PortalPhase["color_key"], string> = {
  sand: "#A08C72",
  charcoal: "#313131",
  teal: "#5F8A82",
  amber: "#B98A4A",
};

/**
 * Read-only Gantt mirror for the client portal — BUILD-SPEC.md "Portal
 * mirror": "add a 'Timeline' section ... following its existing
 * section pattern: phase names + bars + date ranges ONLY (no contacts,
 * no notes), token-gated + rate-limited like siblings, render nothing
 * if no phases." Server component (no client-side fetch — the parent
 * page already queries schedule_phases via the service-role client and
 * passes only PortalPhase-shaped rows down, which never carry
 * contact_id/notes in the first place, so there is no field to
 * accidentally leak here).
 *
 * Reuses the SAME week-grid math as the internal Timeline tab
 * (lib/gantt.ts) so the two views' bar positioning can never drift
 * apart, but renders a much simpler, non-interactive table — no edit
 * panel, no add-phase form, no drag/patch handlers.
 */
export function TimelineSection({ phases }: { phases: PortalPhase[] }) {
  if (phases.length === 0) return null;

  const grid = computeGanttGrid(phases);

  return (
    <PortalSection id="timeline" title="Timeline">
      <div className="overflow-x-auto border border-[#dcd6cc]">
        <div
          className="grid"
          style={{ gridTemplateColumns: `160px repeat(${grid.weekCount}, minmax(20px, 1fr))` }}
        >
          <div className="border-b border-r border-[#dcd6cc] bg-cream px-3 py-2">
            <span className="label-caps">Phase</span>
          </div>
          {grid.weeks.map((week, i) => (
            <div key={i} className="border-b border-[#e5e0d6] bg-cream px-1 py-2 text-center">
              {isNewMonth(grid.weeks, i) && (
                <span className="label-caps whitespace-nowrap">{monthLabel(week)}</span>
              )}
            </div>
          ))}

          {phases.map((phase) => {
            const pos = phaseGridPosition(phase, grid);
            return (
              <div key={phase.id} className="contents">
                <div className="col-start-1 border-b border-r border-[#e5e0d6] px-3 py-2">
                  <p className="text-body text-nearblack">{phase.name}</p>
                  <p className="text-caption text-charcoal/40">
                    {phase.start_date} → {phase.end_date}
                  </p>
                </div>
                <div
                  className="relative border-b border-[#e5e0d6] py-2"
                  style={{ gridColumn: `2 / span ${grid.weekCount}` }}
                >
                  <div
                    className="h-4"
                    style={{
                      marginLeft: `calc((100% / ${grid.weekCount}) * ${pos.startCol - 1})`,
                      width: `calc((100% / ${grid.weekCount}) * ${pos.span})`,
                      backgroundColor: COLOR_SWATCH[phase.color_key],
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </PortalSection>
  );
}
