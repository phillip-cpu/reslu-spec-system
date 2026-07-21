export type SidebarBadgeKey = "my_work_due" | "leads_followups";

export interface SidebarNavItem {
  id: string;
  label: string;
  href: string;
  adminOnly?: boolean;
  badgeKey?: SidebarBadgeKey;
  external?: boolean;
}

/** Stable ids are persisted in user_navigation_preferences.sidebar_order. */
export const SIDEBAR_NAV_ITEMS: SidebarNavItem[] = [
  { id: "my-work", label: "My Work", href: "/my-work", badgeKey: "my_work_due" },
  { id: "projects", label: "Projects", href: "/" },
  { id: "office", label: "Office", href: "/office" },
  { id: "search", label: "Search", href: "/search" },
  { id: "library", label: "Library", href: "/library" },
  { id: "cpd", label: "CPD", href: "/cpd" },
  { id: "contacts", label: "Address Book", href: "/contacts" },
  { id: "leads", label: "Leads", href: "/leads", adminOnly: true, badgeKey: "leads_followups" },
  { id: "marketing", label: "Marketing", href: "/marketing", adminOnly: true },
  { id: "health", label: "Health", href: "/health", adminOnly: true },
  { id: "settings", label: "Settings", href: "/settings" },
  {
    id: "blog",
    label: "Blog",
    href: "https://www.sanity.io/@owfkpTTv2/studio/ugc40fkuw499wo2h5ljfl4ir/default/structure/journal;F9yzAmOGUc9wBOLNgbeWAB",
    external: true,
  },
];

export function visibleSidebarItems(isAdmin: boolean): SidebarNavItem[] {
  return SIDEBAR_NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}

/**
 * Keeps known visible ids in the saved order and appends new/missing
 * navigation entries in their product-default order. Duplicate and stale
 * ids are discarded, so a future nav addition never strands a user's menu.
 */
export function normalizeSidebarOrder(value: unknown, isAdmin: boolean): string[] {
  const visible = visibleSidebarItems(isAdmin).map((item) => item.id);
  const allowed = new Set(visible);
  const saved = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && allowed.has(id))
    : [];
  const unique = [...new Set(saved)];
  return [...unique, ...visible.filter((id) => !unique.includes(id))];
}

export function projectShortcutLabel(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

