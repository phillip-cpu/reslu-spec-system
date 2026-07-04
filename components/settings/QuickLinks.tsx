/**
 * Quick links directory — external services that run the RESLU stack.
 * Requested by Phillip (5 Jul 2026) to keep operational links in one
 * place. Static list by design: these change rarely, and a table for
 * four rows is overkill. Edit here to add/remove entries.
 */
const LINKS: { label: string; note: string; href: string }[] = [
  {
    label: "GitHub",
    note: "Code repository — reslu-spec-system",
    href: "https://github.com",
  },
  {
    label: "Supabase",
    note: "Database, auth, file storage",
    href: "https://supabase.com/dashboard",
  },
  {
    label: "Vercel",
    note: "App hosting & deploys — spec.reslu.com.au",
    href: "https://vercel.com/dashboard",
  },
  {
    label: "Netlify",
    note: "Landing pages hosting",
    href: "https://app.netlify.com",
  },
];

export function QuickLinks() {
  return (
    <div className="divide-y divide-[#dcd6cc] border border-[#dcd6cc] bg-offwhite">
      {LINKS.map((l) => (
        <a
          key={l.label}
          href={l.href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-baseline justify-between gap-4 px-4 py-3 transition-colors hover:bg-nearwhite"
        >
          <span className="text-subhead text-nearblack">{l.label}</span>
          <span className="text-body text-charcoal/70">{l.note}</span>
        </a>
      ))}
    </div>
  );
}
