"use client";

import { useState } from "react";

interface Line {
  id: string;
  description_snapshot: string;
  qty_snapshot: number | null;
  unit_snapshot: string | null;
}
export function SupplierQuoteResponseForm({ token, lines }: { token: string; lines: Line[] }) {
  const [mode, setMode] = useState<"turnaround" | "quote" | "decline">("turnaround");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSending(true);
    setError(null);
    try {
      const form = new FormData(event.currentTarget);
      form.set("action", mode);
      const response = await fetch(`/api/quote-request/${token}/respond`, { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not submit your response");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit your response");
    } finally {
      setSending(false);
    }
  }

  if (done) {
    return (
      <div className="border border-sand bg-cream px-5 py-6">
        <p className="font-display text-subhead text-nearblack">Thank you — your response has been received.</p>
        <p className="mt-2 text-body text-charcoal/70">RESLU’s follow-up list has been updated automatically.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5 border border-[#dcd6cc] bg-white p-5">
      <div>
        <p className="label-caps mb-2">Your response</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {([
            ["turnaround", "I’ll provide a quote"],
            ["quote", "Submit quote now"],
            ["decline", "Unable to quote"],
          ] as const).map(([value, label]) => (
            <button key={value} type="button" onClick={() => setMode(value)} className={`border px-3 py-2 text-body ${mode === value ? "border-nearblack bg-nearblack text-white" : "border-[#c9c2b4] text-charcoal"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {mode === "turnaround" && (
        <label className="block">
          <span className="label-caps">Expected quote date</span>
          <input required name="expected_quote_date" type="date" className="mt-2 w-full border border-[#c9c2b4] px-3 py-2 text-body" />
        </label>
      )}

      {mode === "quote" && (
        <div className="space-y-3">
          <p className="label-caps">Pricing — ex GST</p>
          {lines.map((line) => (
            <label key={line.id} className="grid gap-2 border-b border-[#e5e0d6] pb-3 sm:grid-cols-[1fr_150px] sm:items-center">
              <span className="text-body text-nearblack">
                {line.description_snapshot}
                {line.qty_snapshot !== null && <span className="ml-2 text-charcoal/50">{line.qty_snapshot} {line.unit_snapshot ?? ""}</span>}
              </span>
              <span className="flex items-center border border-[#c9c2b4] bg-white px-2"><span className="text-charcoal/50">$</span><input required min="0" step="0.01" name={`line_amount_${line.id}`} type="number" className="w-full px-2 py-2 text-right text-body outline-none" /></span>
            </label>
          ))}
          <label className="block"><span className="label-caps">Quote reference</span><input name="quote_reference" className="mt-2 w-full border border-[#c9c2b4] px-3 py-2 text-body" /></label>
        </div>
      )}

      <label className="block">
        <span className="label-caps">Message or inclusions/exclusions</span>
        <textarea name="note" rows={4} className="mt-2 w-full border border-[#c9c2b4] px-3 py-2 text-body" />
      </label>

      {mode !== "turnaround" && (
        <label className="block">
          <span className="label-caps">Quote files, photos or supporting documents</span>
          <input name="files" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx" className="mt-2 block w-full text-body" />
        </label>
      )}

      {error && <p className="text-body text-red-700">{error}</p>}
      <button disabled={sending} className="w-full bg-nearblack px-5 py-3 text-subhead text-white disabled:opacity-50">
        {sending ? "Submitting…" : mode === "decline" ? "Send response" : mode === "quote" ? "Submit quotation" : "Confirm turnaround"}
      </button>
    </form>
  );
}
