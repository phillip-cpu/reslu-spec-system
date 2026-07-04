interface Props {
  mondayConfigured: boolean;
  gmailConfigured: boolean;
}

/**
 * Read-only integration status (BUILD-SPEC.md Week 4 task: "Integrations
 * section (read-only: Monday configured? Gmail configured? — check env
 * presence server-side, show green/grey dots)"). Server-checked only —
 * see app/(dashboard)/settings/page.tsx, which passes booleans computed
 * from process.env presence rather than doing that check client-side
 * (env vars are never exposed to the browser here).
 */
export function IntegrationStatus({ mondayConfigured, gmailConfigured }: Props) {
  return (
    <ul className="max-w-lg divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
      <IntegrationRow
        name="Monday.com"
        detail="Procurement sync — pushes items to Monday on status → Ordered."
        configured={mondayConfigured}
      />
      <IntegrationRow
        name="Gmail"
        detail="Team digest — batches client portal activity into an email."
        configured={gmailConfigured}
      />
    </ul>
  );
}

function IntegrationRow({
  name,
  detail,
  configured,
}: {
  name: string;
  detail: string;
  configured: boolean;
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-3">
      <span
        aria-hidden
        className={`h-2.5 w-2.5 shrink-0 ${configured ? "bg-emerald-600" : "bg-charcoal/25"}`}
      />
      <div className="flex-1">
        <p className="text-body text-nearblack">{name}</p>
        <p className="text-caption text-charcoal/50">{detail}</p>
      </div>
      <span className="label-caps !text-charcoal/50">
        {configured ? "Configured" : "Not configured"}
      </span>
    </li>
  );
}
