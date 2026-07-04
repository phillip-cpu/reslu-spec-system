import clsx from "clsx";

export type ProjectTabKey = "overview" | "ffe" | "documents" | "estimate" | "invoices" | "settings";

interface Props {
  projectId: string;
  active: ProjectTabKey;
  isAdmin: boolean;
}

/**
 * Persistent tab bar for the project overview hub (BUILD-SPEC.md
 * "Project overview hub": "Overview | FF&E | Documents | Estimate |
 * Invoices | Settings; financial tabs admin-only"). Deliberately plain
 * styled links, not client-side tab state — per the build spec's own
 * steer ("'tabs' may be styled links, simplest and best"): FF&E,
 * Documents, Estimate, Invoices and Settings are all separate routes
 * already (this keeps every existing deep link working unchanged),
 * Overview is the index route itself. Estimate/Invoices are omitted
 * entirely for non-admins — same "hidden, not merely disabled"
 * pattern as the old header's admin-gated Invoices link, and the
 * routes themselves independently re-check admin server-side.
 */
export function ProjectTabs({ projectId, active, isAdmin }: Props) {
  const tabs: { key: ProjectTabKey; label: string; href: string; adminOnly?: boolean }[] = [
    { key: "overview", label: "Overview", href: `/projects/${projectId}` },
    { key: "ffe", label: "FF&E", href: `/projects/${projectId}?tab=ffe` },
    { key: "documents", label: "Documents", href: `/projects/${projectId}/documents` },
    { key: "estimate", label: "Estimate", href: `/projects/${projectId}/estimate`, adminOnly: true },
    { key: "invoices", label: "Invoices", href: `/projects/${projectId}/invoices`, adminOnly: true },
    { key: "settings", label: "Settings", href: `/projects/${projectId}/settings` },
  ];

  return (
    <nav className="flex border-b border-[#dcd6cc] bg-cream px-8">
      {tabs
        .filter((t) => !t.adminOnly || isAdmin)
        .map((t) => (
          <a
            key={t.key}
            href={t.href}
            className={clsx(
              "border-b-2 px-4 py-3 text-subhead transition-colors",
              active === t.key
                ? "border-nearblack text-nearblack"
                : "border-transparent text-charcoal/60 hover:text-nearblack"
            )}
          >
            {t.label}
          </a>
        ))}
    </nav>
  );
}
