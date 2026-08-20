"use client";

import { useCallback, useEffect, useState } from "react";

type CompanyInvoice = {
  id: string;
  expense_scope: "company" | "unallocated";
  supplier: string;
  invoice_number: string;
  invoice_date: string | null;
  currency_code: string | null;
  amount_ex_gst: number;
  gst: number;
  total: number;
  status: string;
  company_expense_category: string | null;
  recurring_commitment_id: string | null;
  finance_recurring_commitments: { name: string } | null;
};

function money(amount: number, currency: string | null): string {
  if (!currency) return `${amount.toFixed(2)} · currency unresolved`;
  return new Intl.NumberFormat("en-AU", { style: "currency", currency }).format(amount);
}

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/^./, (character) => character.toUpperCase());
}

export function FinanceCompanyInvoicesPanel() {
  const [invoices, setInvoices] = useState<CompanyInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/finance/company-invoices", { cache: "no-store" });
      const body = await response.json() as { invoices?: CompanyInvoice[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not load company bills");
      setInvoices(body.invoices ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load company bills");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  return (
    <section className="border border-charcoal/20 bg-offwhite" aria-labelledby="company-bills-heading">
      <div className="border-b border-charcoal/20 p-5 md:p-7">
        <p className="label-caps">Company expenses</p>
        <h2 id="company-bills-heading" className="mt-2 font-display text-section text-nearblack">Office and recurring bills</h2>
        <p className="mt-2 max-w-2xl text-body text-charcoal/60">
          Every verified supplier invoice can be captured before its job is known. Unallocated bills stay visible here until you tell Stuart which project they belong to or confirm that they are a company expense.
        </p>
      </div>
      {error && <div role="alert" className="border-b border-red-700/30 bg-red-50 p-4 text-body text-red-800">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <thead className="bg-nearblack text-white"><tr className="text-[7px] uppercase tracking-[0.14em]"><th className="px-5 py-3">Supplier</th><th className="px-5 py-3">Invoice</th><th className="px-5 py-3">Category</th><th className="px-5 py-3">Recurring commitment</th><th className="px-5 py-3 text-right">Total</th><th className="px-5 py-3">Status</th></tr></thead>
          <tbody className="divide-y divide-charcoal/10">
            {invoices.map((invoice) => (
              <tr key={invoice.id} className="text-body hover:bg-cream">
                <td className="px-5 py-4 text-nearblack">{invoice.supplier}</td>
                <td className="px-5 py-4"><span className="block text-nearblack">{invoice.invoice_number}</span><span className="mt-1 block text-caption text-charcoal/45">{invoice.invoice_date ?? "Date unresolved"}</span></td>
                <td className="px-5 py-4">{invoice.expense_scope === "unallocated" ? "Unallocated — job or company pending" : label(invoice.company_expense_category ?? "other")}</td>
                <td className="px-5 py-4">{invoice.finance_recurring_commitments?.name ?? "Not linked"}</td>
                <td className="px-5 py-4 text-right text-nearblack">{money(Number(invoice.total), invoice.currency_code)}</td>
                <td className="px-5 py-4"><span className="border border-charcoal/25 px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em]">{invoice.status}</span></td>
              </tr>
            ))}
            {!loading && invoices.length === 0 && <tr><td colSpan={6} className="px-5 py-12 text-center text-body text-charcoal/50">No company or unallocated bills have been staged yet.</td></tr>}
            {loading && <tr><td colSpan={6} className="px-5 py-12 text-center text-body text-charcoal/50">Loading company bills…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}
