interface AppErrorRow {
  id: string;
  where_at: string;
  message: string;
  stack: string | null;
  created_at: string;
}

/**
 * System health — admin-only (BUILD-SPEC.md Phase 14 "admin Settings
 * section 'System health' listing last 50 errors"). Server-rendered,
 * same pattern as IntegrationStatus.tsx (no client fetch needed for a
 * read-only admin list) — the last 50 app_errors rows
 * (migration 022_perf_indexes.sql) are passed in from
 * app/(dashboard)/settings/page.tsx, which is itself already
 * admin-gated for the sections that need it.
 *
 * Deliberately no delete/dismiss UI — this is a lightweight, append-
 * only log (see lib/report-error.ts); once Sentry (or similar) is
 * adopted as the documented upgrade path (docs/RUNBOOK.md §9), this
 * whole section can be retired in favour of that tool's own dashboard.
 */
export function SystemHealth({ errors }: { errors: AppErrorRow[] }) {
  return (
    <div className="max-w-2xl">
      <p className="mb-3 text-caption text-charcoal/50">
        Last {errors.length} server-side error{errors.length === 1 ? "" : "s"}, most recent first —
        from the PDF route, scrape pipeline, Monday sync, Gmail send, and signature route.
        Nothing here alerts anyone automatically; this is a manual check-in tool. Sentry (or
        similar) is the documented upgrade path for real-time alerting — see docs/RUNBOOK.md.
      </p>

      {errors.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] p-6 text-center text-body text-charcoal/50">
          No errors recorded. This list only shows failures from a handful of instrumented
          spots — an empty list means those haven&apos;t failed recently, not that nothing has
          ever gone wrong anywhere in the app.
        </p>
      ) : (
        <ul className="max-h-[32rem] divide-y divide-[#e5e0d6] overflow-y-auto border border-[#dcd6cc] bg-offwhite">
          {errors.map((e) => (
            <li key={e.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="label-caps !text-sand">{e.where_at}</span>
                <span className="shrink-0 text-caption text-charcoal/40">
                  {new Date(e.created_at).toLocaleString("en-AU", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
              <p className="mt-1 text-body text-nearblack">{e.message}</p>
              {e.stack && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-caption text-charcoal/40 hover:text-charcoal/70">
                    Stack excerpt
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-nearwhite p-2 text-caption text-charcoal/60">
                    {e.stack}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
