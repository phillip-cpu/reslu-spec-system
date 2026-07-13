"use client";

import { useEffect, useState } from "react";
import type { ClientInvoice } from "@/types/client-invoices";

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * "Unlinked invoices" — BUILD-SPEC.md r27 item 7. Client_invoices rows
 * with project_id still null (a deposit invoice raised off a lead-only
 * accepted proposal, before that lead became a project — see migration
 * 054's own comment) never appear on any project's Invoices tab, since
 * that tab is inherently project-scoped
 * (components/invoices/ClientInvoiceQueue.tsx's own "SKIP v1, no global
 * list" note). Rather than build a whole new global invoices page for
 * what should be a rare, self-clearing list (POST
 * /api/leads/[id]/create-project backfills project_id automatically
 * the moment the lead becomes a job), this mounts as one small,
 * collapsed-when-empty panel on the existing admin-only /leads page
 * (components/leads/LeadsWorkspace.tsx) — the least-new-surface option
 * per this round's own build note, and thematically the right home
 * (every orphan traces back to a lead-stage proposal accept). Office
 * was the other candidate the brief named, but Office
 * (app/(dashboard)/office/page.tsx) is explicitly team-visible with NO
 * admin gating, and invoice amounts/client details are financial data
 * — same gating tier as every other client_invoices surface — so
 * /leads (already admin-only, already "financial-adjacent" per its own
 * page header comment) is the correct fit, not a gating regression.
 *
 * Read-only: this panel does not offer a "link to project" action
 * (there's no UI anywhere yet to search-and-pick an arbitrary project
 * to attach an existing invoice to) — a genuinely stuck row still
 * needs the existing per-invoice admin tools; this only makes it
 * visible, which is the round's literal ask ("gains an 'Unlinked
 * invoices' LIST").
 */
export function UnlinkedInvoicesPanel() {
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/client-invoices/unlinked")
      .then((r) => (r.ok ? r.json() : { invoices: [] }))
      .then((body) => {
        if (!cancelled) setInvoices(body.invoices ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // Quiet by design — nothing renders while loading, and nothing
  // renders once loaded if the list is empty (the common, healthy
  // case: create-project's backfill means this should self-clear).
  if (loading || invoices.length === 0) return null;

  return (
    <div className="border border-sand bg-cream px-4 py-3">
      <p className="label-caps mb-2">
        Unlinked invoices <span className="text-charcoal/50">({invoices.length})</span>
      </p>
      <p className="mb-3 text-caption text-charcoal/60">
        Client invoices with no project attached yet — usually a design-fee deposit drafted before the lead became a
        job. Progressing the lead to a project links these automatically.
      </p>
      <div className="space-y-1">
        {invoices.map((inv) => (
          <div key={inv.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-[#e5e0d6] py-1.5 last:border-b-0">
            <div className="min-w-0">
              <span className="text-body text-nearblack">{inv.invoice_number}</span>
              <span className="ml-2 text-caption text-charcoal/60">{inv.client_name}</span>
            </div>
            <div className="flex items-center gap-3 text-caption text-charcoal/70">
              <span>{formatMoney(inv.total_inc_gst)}</span>
              <span className="uppercase">{inv.status}</span>
              <a
                href={`/api/client-invoices/${inv.id}/pdf`}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-nearblack"
              >
                PDF
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
