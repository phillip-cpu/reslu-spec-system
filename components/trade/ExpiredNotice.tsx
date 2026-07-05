/**
 * Shown on /trade/[token] when the visit's confirm link has expired
 * (deleted, or its date range has passed) — the trade-page equivalent
 * of a polite "nothing to see here" state. Mobile-first single column,
 * matches the brand's sharp-corners / sand-accent conventions.
 */
export function ExpiredNotice() {
  return (
    <div className="border border-[#dcd6cc] bg-offwhite px-5 py-8 text-center">
      <p className="label-caps">Link expired</p>
      <p className="mt-3 text-body text-charcoal/70">
        This confirmation link is no longer active. If you still need to confirm or change this
        visit, please contact RESLU directly.
      </p>
    </div>
  );
}
