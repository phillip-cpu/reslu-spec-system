import type { ReactNode } from "react";

export function SettingsJumpNav() {
  const links = [
    ["project-setup", "Projects & templates"],
    ["people-business", "People & business"],
    ["communications", "Communications"],
    ["connections-system", "Connections & system"],
  ];
  return (
    <nav className="flex flex-wrap gap-2" aria-label="Settings sections">
      {links.map(([href, label]) => (
        <a
          key={href}
          href={`#${href}`}
          className="border border-[#c9c2b4] bg-offwhite px-3 py-2 text-caption text-charcoal hover:border-nearblack hover:text-nearblack"
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

export function SettingsGroup({
  id,
  title,
  description,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details id={id} open={defaultOpen} className="group scroll-mt-4 border border-[#dcd6cc] bg-offwhite">
      <summary className="cursor-pointer list-none px-5 py-4 marker:hidden">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-subhead text-nearblack">{title}</h2>
            <p className="mt-1 text-caption text-charcoal/55">{description}</p>
          </div>
          <span aria-hidden className="text-section font-light text-charcoal/45 group-open:rotate-45">+</span>
        </div>
      </summary>
      <div className="space-y-12 border-t border-[#dcd6cc] px-5 py-6">{children}</div>
    </details>
  );
}

