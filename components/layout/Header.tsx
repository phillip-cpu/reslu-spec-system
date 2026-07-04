import type { ReactNode } from "react";

interface HeaderProps {
  title: string;
  subtitle?: string;
  subtitleHref?: string;
  actions?: ReactNode;
}

export function Header({ title, subtitle, subtitleHref, actions }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-[#dcd6cc] px-8 py-6 bg-cream">
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
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  );
}
