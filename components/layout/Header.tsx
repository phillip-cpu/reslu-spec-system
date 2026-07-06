import type { ReactNode } from "react";
import Image from "next/image";

interface HeaderProps {
  title: string;
  subtitle?: string;
  subtitleHref?: string;
  actions?: ReactNode;
  /** Week 7 — project cover image thumbnail shown next to the title (signed URL, minted server-side). */
  titleThumbnailUrl?: string | null;
  /**
   * Housekeeping (Phase 12a-B) — BUILD-SPEC.md §"Housekeeping — 5 July
   * screenshot" point 1: "on every project sub-tab ... the project name
   * in the header links to the project Overview." When set, the title
   * itself becomes a link — additive/optional, so every existing call
   * site (which only ever passed a plain string title) renders exactly
   * as before.
   */
  titleHref?: string;
  /**
   * Housekeeping (Phase 12a-B) — BUILD-SPEC.md §"Housekeeping — 5 July
   * screenshot" point 2: projects.alias "displayed as a muted
   * suffix/subtitle ... on ... project header". Rendered muted, right
   * next to the title, on internal pages only — callers never pass
   * this for the client portal header (a separate component,
   * app/portal/[token]/page.tsx, which doesn't use this component at
   * all) or the PDF cover.
   */
  titleSuffix?: string | null;
  /**
   * "Three from Phillip — 6 July 2026 evening" item 2 (migration
   * 028_job_numbers.sql): job number rendered "muted, near alias" in
   * the project header. Slotted in BEFORE titleSuffix (alias), same
   * muted class, so the two read as one consistent metadata cluster
   * next to the title (e.g. "Smith Residence  #026  Nth Adelaide
   * townhouse") rather than two competing styles. Unlike alias, this
   * one also appears on PDFs — but never in this internal-only Header
   * component's own client-portal counterpart, since that's a separate
   * component entirely (see titleSuffix's own doc comment above).
   */
  jobNumber?: string | null;
}

export function Header({
  title,
  subtitle,
  subtitleHref,
  actions,
  titleThumbnailUrl,
  titleHref,
  titleSuffix,
  jobNumber,
}: HeaderProps) {
  const titleEl = (
    <h1 className="text-section font-display text-nearblack">
      {title}
      {jobNumber && <span className="ml-2 text-body font-sans text-charcoal/40">#{jobNumber}</span>}
      {titleSuffix && <span className="ml-2 text-body font-sans text-charcoal/40">{titleSuffix}</span>}
    </h1>
  );

  return (
    <header className="flex items-center justify-between border-b border-[#dcd6cc] px-8 py-6 bg-cream">
      <div className="flex items-center gap-4">
        {titleThumbnailUrl && (
          <div className="relative h-12 w-16 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
            <Image src={titleThumbnailUrl} alt="" fill sizes="64px" className="object-cover" />
          </div>
        )}
        <div>
          {titleHref ? (
            <a href={titleHref} className="inline-block transition-colors hover:text-sand">
              {titleEl}
            </a>
          ) : (
            titleEl
          )}
          {subtitle &&
            (subtitleHref ? (
              <a
                href={subtitleHref}
                className="text-body text-charcoal/70 mt-1 inline-block transition-colors hover:text-nearblack hover:underline"
              >
                {subtitle}
              </a>
            ) : (
              <p className="text-body text-charcoal/70 mt-1">{subtitle}</p>
            ))}
        </div>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  );
}
