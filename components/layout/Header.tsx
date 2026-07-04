import type { ReactNode } from "react";

interface HeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function Header({ title, subtitle, actions }: HeaderProps) {
  return (
    <header className="flex items-center justify-between border-b border-[#dcd6cc] px-8 py-6 bg-cream">
      <div>
        <h1 className="text-section font-display text-nearblack">{title}</h1>
        {subtitle && <p className="text-body text-charcoal/70 mt-1">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  );
}
