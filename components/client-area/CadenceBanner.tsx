import clsx from "clsx";

/**
 * "Last update published N days ago" hint (BUILD-SPEC.md "Team-side
 * client area": "Fortnightly cadence hint: show 'Last update published
 * N days ago' with amber >14 days").
 */
export function CadenceBanner({
  cadence,
}: {
  cadence: { last_published_at: string | null; days_since_last_update: number | null; stale: boolean };
}) {
  const message =
    cadence.days_since_last_update === null
      ? "No updates have been published yet."
      : cadence.days_since_last_update === 0
        ? "Last update published today."
        : `Last update published ${cadence.days_since_last_update} day${cadence.days_since_last_update === 1 ? "" : "s"} ago.`;

  return (
    <p
      className={clsx(
        "border px-4 py-2 text-body",
        cadence.stale ? "border-amber-600/40 bg-amber-50 text-amber-800" : "border-[#dcd6cc] bg-nearwhite text-charcoal/70"
      )}
    >
      {message}
    </p>
  );
}
