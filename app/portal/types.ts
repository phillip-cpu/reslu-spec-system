import type { PortalItem } from "@/types";

/**
 * Portal-local type additions.
 *
 * types/index.ts is owned by the scraper/library agent working in this
 * same tree concurrently (see task file-boundary rules) — new types
 * needed only by the portal/PDF surfaces are defined here instead of
 * editing that shared file.
 */

/** A downloadable document surfaced on the portal, with a signed URL. */
export interface PortalItemFile {
  id: string;
  kind: "spec_sheet" | "install_manual" | "other";
  filename: string;
  /** Time-limited signed Supabase Storage URL — never a public/permanent one. */
  url: string;
}

/** PortalItem extended with its downloadable documents. */
export interface PortalItemWithFiles extends PortalItem {
  files: PortalItemFile[];
}
