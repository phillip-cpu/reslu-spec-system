import type { TradeDocumentRow } from "@/types/trade-doc-pack";

/**
 * "Trade booking document pack" round — the trade page's DOCUMENTS
 * section (BUILD-SPEC.md item 3). Plain server-rendered presentational
 * component (no "use client" — mirrors components/trade/
 * WhoElseOnSite.tsx's own shape exactly), handed already-resolved rows
 * by app/trade/[token]/page.tsx (a Server Component itself), which does
 * ALL the resolution work (latest plans/SOW lookups, signed-URL-vs-
 * proxy-link decisions) server-side before this component ever renders
 * — same "caller resolves, component only displays" division of labour
 * WhoElseOnSite already establishes for "who else is on site."
 *
 * Renders nothing at all when `rows` is empty (BUILD-SPEC.md's own
 * distinction: a visit with document_pack === null never even calls
 * this component — see the trade page's own render logic — while a
 * visit WITH a pack but where every choice's live document has since
 * disappeared renders this component with an empty `rows` array,
 * which this component also treats as "nothing to show," identically).
 */
export function TradeDocuments({ rows }: { rows: TradeDocumentRow[] }) {
  if (rows.length === 0) return null;

  return (
    <div className="border border-[#dcd6cc] px-4 py-4">
      <p className="label-caps">Documents</p>
      <ul className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <li key={row.kind} className="flex items-center justify-between gap-3 text-body text-nearblack">
            <a
              href={row.href}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate underline decoration-charcoal/30 underline-offset-2 hover:decoration-nearblack"
            >
              {row.label}
            </a>
            {row.sizeLabel && (
              <span className="shrink-0 text-caption text-charcoal/40">{row.sizeLabel}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
