"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Contact, EstimateResponse } from "@/types";
import type { SupplierQuotePackage, SupplierQuoteRequest } from "@/types/supplier-quotes";
import { formatMoney } from "./EstimateWorkspace";

function requestLabel(request: SupplierQuoteRequest): string {
  if (request.status === "quote_received") return "Quote received";
  if (request.status === "acknowledged") return request.promised_quote_at ? `Promised ${request.promised_quote_at}` : "Turnaround needed";
  if (request.status === "selected") return "Selected";
  if (request.status === "declined") return "Declined";
  if (request.status === "closed") return "Closed";
  if (request.status === "sent") return "Sent — awaiting reply";
  return "Draft";
}

export function QuoteRequestsPanel({ projectId, estimate, onEstimateReload }: { projectId: string; estimate: EstimateResponse | null; onEstimateReload: () => void }) {
  const [packages, setPackages] = useState<SupplierQuotePackage[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [sendingPackageId, setSendingPackageId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [scope, setScope] = useState("");
  const [requestedDate, setRequestedDate] = useState("");
  const [lineIds, setLineIds] = useState<Set<string>>(new Set());
  const [contactIds, setContactIds] = useState<Set<string>>(new Set());
  const [files, setFiles] = useState<File[]>([]);

  const load = useCallback(async () => {
    await Promise.resolve();
    setLoading(true);
    try {
      const [quotesResponse, contactsResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/quote-requests`, { cache: "no-store" }),
        fetch("/api/contacts?limit=2000", { cache: "no-store" }),
      ]);
      const quotesBody = await quotesResponse.json();
      const contactsBody = await contactsResponse.json();
      if (!quotesResponse.ok) throw new Error(quotesBody.error ?? "Could not load quote requests");
      setPackages(quotesBody.packages ?? []);
      setContacts((contactsBody.contacts ?? []).filter((contact: Contact) => contact.email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load quote requests");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const allLines = useMemo(() => estimate?.sections.flatMap((section) => section.lines.map((line) => ({ ...line, section_name: section.name }))) ?? [], [estimate]);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  async function createAndSend(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || lineIds.size === 0 || contactIds.size === 0) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/quote-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), scope: scope.trim() || null, requested_quote_date: requestedDate || null, line_ids: [...lineIds], contact_ids: [...contactIds] }),
      });
      const body = await response.json();
      if (!response.ok || !body.package) throw new Error(body.error ?? "Could not create quote package");
      if (files.length > 0) {
        const form = new FormData();
        files.forEach((file) => form.append("files", file));
        const upload = await fetch(`/api/quote-packages/${body.package.id}/attachments`, { method: "POST", body: form });
        const uploadBody = await upload.json();
        if (!upload.ok) throw new Error(uploadBody.error ?? "Could not upload quote attachments");
      }
      const send = await fetch(`/api/quote-packages/${body.package.id}/send`, { method: "POST" });
      const sendBody = await send.json();
      if (!send.ok) throw new Error(sendBody.error ?? sendBody.errors?.join("; ") ?? "Could not send quote requests");
      if (sendBody.errors?.length) setError(`Some requests need attention: ${sendBody.errors.join("; ")}`);
      setTitle(""); setScope(""); setRequestedDate(""); setLineIds(new Set()); setContactIds(new Set()); setFiles([]);
      await load();
      onEstimateReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create quote package");
    } finally {
      setCreating(false);
    }
  }

  async function updateRequest(requestId: string, patch: Record<string, unknown>) {
    setError(null);
    const response = await fetch(`/api/quote-requests/${requestId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Could not update quote request"); return; }
    await load();
    onEstimateReload();
  }

  async function followUp(requestId: string) {
    const response = await fetch(`/api/quote-requests/${requestId}/follow-up`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) setError(body.error ?? "Could not send follow-up");
    else await load();
  }

  async function retryPackage(packageId: string) {
    setSendingPackageId(packageId);
    setError(null);
    try {
      const response = await fetch(`/api/quote-packages/${packageId}/send`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? body.errors?.join("; ") ?? "Could not send quote requests");
      if (body.errors?.length) setError(`Some requests still need attention: ${body.errors.join("; ")}`);
      await load();
      onEstimateReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send quote requests");
    } finally {
      setSendingPackageId(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && <p className="border border-red-700/40 bg-red-50 px-4 py-3 text-body text-red-700">{error}</p>}
      <form onSubmit={createAndSend} className="space-y-5 border border-nearblack bg-offwhite p-5">
        <div><p className="label-caps">New quote package</p><p className="mt-1 text-body text-charcoal/60">Choose estimate lines and competing suppliers. Each supplier receives a separately tracked email thread.</p></div>
        <div className="grid gap-4 md:grid-cols-2">
          <label><span className="label-caps">Package title</span><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Windows & Doors" className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>
          <label><span className="label-caps">Requested quote date</span><input type="date" value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>
        </div>
        <label className="block"><span className="label-caps">Scope and instructions</span><textarea value={scope} onChange={(event) => setScope(event.target.value)} rows={4} className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>
        <div className="grid gap-5 lg:grid-cols-2">
          <fieldset><legend className="label-caps mb-2">Estimate lines</legend><div className="max-h-64 overflow-y-auto border border-[#dcd6cc] bg-white">{allLines.map((line) => <label key={line.id} className="flex gap-3 border-b border-[#e5e0d6] px-3 py-2 text-body last:border-0"><input type="checkbox" checked={lineIds.has(line.id)} onChange={() => toggle(setLineIds, line.id)} /><span><span className="block text-nearblack">{line.description}</span><span className="text-caption text-charcoal/50">{line.section_name}</span></span></label>)}</div></fieldset>
          <fieldset><legend className="label-caps mb-2">Suppliers</legend><div className="max-h-64 overflow-y-auto border border-[#dcd6cc] bg-white">{contacts.map((contact) => <label key={contact.id} className="flex gap-3 border-b border-[#e5e0d6] px-3 py-2 text-body last:border-0"><input type="checkbox" checked={contactIds.has(contact.id)} onChange={() => toggle(setContactIds, contact.id)} /><span><span className="block text-nearblack">{contact.company}</span><span className="text-caption text-charcoal/50">{contact.email}</span></span></label>)}</div></fieldset>
        </div>
        <label className="block"><span className="label-caps">Images, drawings and documents</span><input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} className="mt-2 block w-full text-body" />{files.length > 0 && <span className="mt-1 block text-caption text-charcoal/55">{files.map((file) => file.name).join(" · ")}</span>}</label>
        <button disabled={creating || !title.trim() || lineIds.size === 0 || contactIds.size === 0} className="bg-nearblack px-5 py-2.5 text-subhead text-white disabled:opacity-40">{creating ? "Creating and sending…" : `Create and send ${contactIds.size || ""} request${contactIds.size === 1 ? "" : "s"}`}</button>
      </form>

      <section className="space-y-4">
        <div><p className="label-caps">Quote register</p><p className="mt-1 text-caption text-charcoal/55">Email replies, promised dates and submitted files stay attached to their package and every included estimate line.</p></div>
        {loading ? <p className="text-body text-charcoal/50">Loading quote requests…</p> : packages.length === 0 ? <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/50">No quote requests yet.</p> : packages.map((quotePackage) => (
          <article key={quotePackage.id} id={`quote-package-${quotePackage.id}`} className="border border-[#dcd6cc] bg-white">
            <header className="flex flex-wrap items-start justify-between gap-3 bg-cream px-4 py-3"><div><h3 className="font-display text-subhead text-nearblack">{quotePackage.title}</h3><p className="mt-1 text-caption text-charcoal/55">{quotePackage.lines.map((line) => line.description_snapshot).join(" · ")}</p></div><div className="flex items-center gap-2">{quotePackage.requests.some((request) => request.status === "draft") && <button type="button" disabled={sendingPackageId === quotePackage.id} onClick={() => retryPackage(quotePackage.id)} className="border border-nearblack px-2 py-1 text-caption disabled:opacity-40">{sendingPackageId === quotePackage.id ? "Sending…" : "Send remaining"}</button>}<span className="label-caps border border-sand px-2 py-1 text-sand">{quotePackage.status}</span></div></header>
            {quotePackage.attachments.filter((file) => file.kind === "request").length > 0 && <div className="flex flex-wrap gap-2 border-b border-[#e5e0d6] px-4 py-3">{quotePackage.attachments.filter((file) => file.kind === "request").map((file) => <a key={file.id} href={file.url ?? "#"} target="_blank" rel="noreferrer" className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal hover:border-nearblack">{file.filename}</a>)}</div>}
            <div className="divide-y divide-[#e5e0d6]">{quotePackage.requests.map((request) => (
              <div key={request.id} className="space-y-3 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-body font-medium text-nearblack">{request.contact?.company ?? request.sent_to_email ?? "Supplier"}</p><p className="text-caption text-charcoal/55">{requestLabel(request)}{request.quote_amount_ex_gst !== null ? ` · ${formatMoney(request.quote_amount_ex_gst)} ex GST` : ""}</p></div><div className="flex flex-wrap gap-2">{["sent", "acknowledged"].includes(request.status) && <button type="button" onClick={() => followUp(request.id)} className="border border-[#c9c2b4] px-2 py-1 text-caption">Send follow-up</button>}{request.status === "quote_received" && <button type="button" onClick={() => updateRequest(request.id, { status: "selected" })} className="bg-nearblack px-3 py-1 text-caption text-white">Select quote</button>}</div></div>
                {request.status === "acknowledged" && !request.promised_quote_at && <label className="flex flex-wrap items-center gap-2 text-caption text-charcoal/60">Promised date <input type="date" onChange={(event) => event.target.value && updateRequest(request.id, { promised_quote_at: event.target.value })} className="border border-[#c9c2b4] px-2 py-1" /></label>}
                {request.response_note && <p className="whitespace-pre-wrap border-l-2 border-sand pl-3 text-body text-charcoal/70">{request.response_note}</p>}
                {request.response_lines.length > 0 && <div className="grid gap-1 text-caption">{request.response_lines.map((responseLine) => { const line = quotePackage.lines.find((item) => item.id === responseLine.package_line_id); return <div key={responseLine.package_line_id} className="flex justify-between gap-3"><span>{line?.description_snapshot ?? "Line item"}</span><span>{responseLine.amount_ex_gst === null ? "—" : `${formatMoney(responseLine.amount_ex_gst)} ex GST`}</span></div>; })}</div>}
                {quotePackage.attachments.filter((file) => file.request_id === request.id && file.kind === "response").map((file) => <a key={file.id} href={file.url ?? "#"} target="_blank" rel="noreferrer" className="mr-2 inline-block border border-[#c9c2b4] px-2 py-1 text-caption">{file.filename}</a>)}
                {request.emails.length > 0 && <details><summary className="cursor-pointer text-caption text-sand">Email history ({request.emails.length})</summary><div className="mt-2 space-y-2">{request.emails.map((email) => <div key={email.id} className="border border-[#e5e0d6] bg-offwhite p-3"><p className="text-caption text-charcoal/50">{email.direction === "inbound" ? "From" : "Sent"} {email.from_addr} · {new Date(email.received_at).toLocaleDateString("en-AU")}</p><p className="mt-1 text-body font-medium">{email.subject}</p>{email.clean_text && <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-caption text-charcoal/70">{email.clean_text}</p>}{email.attachments.length > 0 && <p className="mt-2 text-caption text-sand">Attachments: {email.attachments.map((file) => file.filename).join(", ")}</p>}</div>)}</div></details>}
              </div>
            ))}</div>
          </article>
        ))}
      </section>
    </div>
  );
}
