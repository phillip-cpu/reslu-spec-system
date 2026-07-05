/**
 * Shared "build the client portal URL from a token" helper — used by
 * every project sub-tab page's ProjectTabs "View client portal" link
 * (BUILD-SPEC.md §"Housekeeping — 5 July screenshot" point 3) and the
 * Settings page's own portal-link display, so the exact same
 * appUrl-trim-plus-token logic isn't hand-copied at each of this
 * component's ten call sites (and the Settings page, which already had
 * its own inline copy before this task — left as-is there since it is
 * outside this task's need to touch, but this helper is the one new
 * call sites should use).
 */
export function portalUrlFor(token: string): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${appUrl}/portal/${token}`;
}
