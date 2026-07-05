import type { VisitStatus } from "@/lib/trade-visits";

const STATUS_LABELS: Partial<Record<VisitStatus, string>> = {
  confirmed: "Confirmed",
  tentative: "Tentative",
};

/**
 * "Who else is on site" — trade page + reminder email. Company name +
 * status label ONLY, per BUILD-SPEC.md's explicit privacy requirement:
 * no contact_name/phone/email of other trades is ever passed to this
 * component (the caller — app/trade/[token]/page.tsx — only fetches
 * `company` for the overlapping visits' contacts). Only confirmed/
 * tentative visits are ever passed in (declined/unconfirmed/
 * proposed_change are filtered out by the caller before this renders).
 */
export function WhoElseOnSite({ entries }: { entries: { company: string; status: VisitStatus }[] }) {
  if (entries.length === 0) return null;

  return (
    <div className="border border-[#dcd6cc] px-4 py-4">
      <p className="label-caps">Who else is on site this week</p>
      <ul className="mt-2 space-y-1.5">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-center justify-between text-body text-nearblack">
            <span>{entry.company}</span>
            <span className="text-caption text-charcoal/50">{STATUS_LABELS[entry.status] ?? entry.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
