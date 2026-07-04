import clsx from "clsx";
import type { ItemStatus } from "@/types";

/**
 * Item lifecycle badge — the only procurement signal shown outside the
 * internal Pricing & Procurement view (BUILD-SPEC.md §2). Five states,
 * charcoal→sand progression; no colour beyond the brand palette.
 */
const STYLES: Record<ItemStatus, string> = {
  Specced: "border-charcoal/40 text-charcoal/60",
  Quoted: "border-charcoal text-charcoal",
  Ordered: "border-sand text-sand",
  "On Site": "border-nearblack text-nearblack",
  Installed: "border-nearblack bg-nearblack text-white",
};

export function ItemStatusBadge({ status }: { status: ItemStatus }) {
  return (
    <span
      className={clsx(
        "label-caps inline-block whitespace-nowrap border px-2 py-1",
        STYLES[status]
      )}
    >
      {status}
    </span>
  );
}
