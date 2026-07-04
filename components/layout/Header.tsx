import type { ReactNode } from "react";
import Image from "next/image";

interface HeaderProps {
  title: string;
  subtitle?: string;
  subtitleHref?: string;
  actions?: ReactNode;
  /** Week 7 — project cover image thumbnail shown next to the title (signed URL, minted server-side). */
  titleThumbnailUrl?: string | null;
}

export function Header({ title, subtitle, subtitleHref, actions, titleThumbnailUrl }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-[#dcd6cc] px-8 py-6 bg-cream">
      <div className="flex items-center gap-4">
        {titleThumbnailUrl && (
          <div className="relative h-12 w-16 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
            <Image src={titleThumbnailUrl} alt="" fill sizes="64px" className="object-cover" />
          </div>
        )}
        <div>
          <h1 className="text-section font-display text-nearblack">{title}</h1>
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
