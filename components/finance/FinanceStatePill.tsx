import clsx from "clsx";
import type { ProjectFinanceState } from "@/types/finance";

const LABELS: Record<ProjectFinanceState, string> = {
  design_only: "Design only",
  candidate: "Candidate",
  ready: "Ready",
  active: "Active base",
  suspended: "Suspended",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function FinanceStatePill({ state }: { state: ProjectFinanceState }) {
  return (
    <span
      className={clsx(
        "inline-flex border px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em]",
        state === "active" && "border-[#4c6b4f] bg-[#4c6b4f]/10 text-[#304b33]",
        state === "ready" && "border-[#a08c72] bg-sand/10 text-charcoal",
        state === "candidate" && "border-[#c9971e] bg-[#c9971e]/10 text-[#76570a]",
        state === "design_only" && "border-charcoal/20 text-charcoal/55",
        ["suspended", "cancelled"].includes(state) &&
          "border-red-700/40 bg-red-700/5 text-red-800",
        state === "closed" && "border-charcoal/30 bg-charcoal/5 text-charcoal/65"
      )}
    >
      {LABELS[state]}
    </span>
  );
}
