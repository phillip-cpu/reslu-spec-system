"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Contact, EstimateResponse } from "@/types";
import type { SupplierQuotePackage, SupplierQuoteRequest } from "@/types/supplier-quotes";
import { formatMoney } from "./EstimateWorkspace";

interface ExistingQuoteEmail {
  id: string;
  suggestion_id: string | null;
  subject: string | null;
  received_at: string;
  direction: "inbound" | "sent";
  from_addr: string;
  to_addrs: string[];
  has_thread_id: boolean;
  preview: string | null;
  external_email: string | null;
  project_confidence: number;
  suggested_line_ids: string[];
  line_candidates: { id: string; description: string; confidence: number; reason: string; selected: boolean }[];
  suggested_contact: { id: string; company: string; email: string | null } | null;
}

function requestLabel(request: SupplierQuoteRequest): string {
  if (request.status === "quote_received") return "Quote received";
  if (request.status === "acknowledged") return request.promised_quote_at ? `Promised ${request.promised_quote_at}` : "Turnaround needed";
  if (request.status === "selected") return "Selected";
  if (request.status === "declined") return "Declined";
  if (request.status === "closed") return "Closed";
  if (request.status === "sent") return "Sent — awaiting reply";
  return "Draft";
}

export function QuoteRequestsPanel({ projectId, estimate, onEstimateReload, initialLineIds = [] }: { projectId: string; estimate: EstimateResponse | null; onEstimateReload: () => void; initialLineIds?: string[] }) {
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
  const [lineSearch, setLineSearch] = useState("");
  const [contactSearch, setContactSearch] = useState("");
  const [sourceMode, setSourceMode] = useState<"new" | "existing">("new");
  const [existingEmails, setExistingEmails] = useState<ExistingQuoteEmail[]>([]);
  const [existingEmailId, setExistingEmailId] = useState("");
  const [newContactCompany, setNewContactCompany] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  const allLines = useMemo(() => estimate?.sections.flatMap((section) => section.lines.map((line) => ({ ...line, section_name: section.name }))) ?? [], [estimate]);
  const lineGroups = useMemo(() => {
    const query = lineSearch.trim().toLowerCase();
    return (estimate?.sections ?? []).map((section) => ({
      ...section,
      lines: section.lines.filter((line) => !query || `${section.name} ${line.description}`.toLowerCase().includes(query)),
    })).filter((section) => section.lines.length > 0);
  }, [estimate, lineSearch]);
  const filteredContacts = useMemo(() => {
    const query = contactSearch.trim().toLowerCase();
    return contacts.filter((contact) => !query || [contact.company, contact.contact_name, contact.email, contact.specialty, contact.category].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [contactSearch, contacts]);
  const selectedExistingEmail = useMemo(() => existingEmails.find((email) => email.id === existingEmailId) ?? null, [existingEmailId, existingEmails]);

  const load = useCallback(async () => {
    await Promise.resolve();
    setLoading(true);
    try {
      const [quotesResponse, contactsResponse, emailsResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/quote-requests`, { cache: "no-store" }),
        fetch("/api/contacts?limit=2000", { cache: "no-store" }),
        fetch(`/api/projects/${projectId}/quote-requests/import-email`, { cache: "no-store" }),
      ]);
      const quotesBody = await quotesResponse.json();
      const contactsBody = await contactsResponse.json();
      const emailsBody = await emailsResponse.json();
      if (!quotesResponse.ok) throw new Error(quotesBody.error ?? "Could not load quote requests");
      if (!emailsResponse.ok) throw new Error(emailsBody.error ?? "Could not load existing quote emails");
      setPackages(quotesBody.packages ?? []);
      setContacts((contactsBody.contacts ?? []).filter((contact: Contact) => contact.email));
      setExistingEmails(emailsBody.emails ?? []);
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

  const initialLineKey = initialLineIds.join(",");
  useEffect(() => {
    if (!initialLineKey || allLines.length === 0) return;
    const timer = window.setTimeout(() => {
      const requested = new Set(initialLineIds);
      const validLines = allLines.filter((line) => requested.has(line.id));
      if (validLines.length === 0) return;
      setLineIds(new Set(validLines.map((line) => line.id)));
      setContactIds(new Set(validLines.map((line) => line.contact_id).filter((id): id is string => Boolean(id))));
      setTitle((current) => current || (validLines.length === 1 ? validLines[0].description : validLines[0].section_name));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [allLines, initialLineIds, initialLineKey]);

  function toggle(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) {
    setter((current) => { const next = new Set(current); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  function toggleSection(sectionLineIds: string[]) {
    setLineIds((current) => {
      const next = new Set(current);
      const allSelected = sectionLineIds.every((id) => next.has(id));
      for (const id of sectionLineIds) allSelected ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleContact(id: string) {
    if (sourceMode === "existing") {
      setContactIds((current) => current.has(id) ? new Set() : new Set([id]));
      return;
    }
    toggle(setContactIds, id);
  }

  function chooseExistingEmail(email: ExistingQuoteEmail) {
    setExistingEmailId(email.id);
    setTitle((current) => current || email.subject?.replace(/^\s*(?:re:\s*)?(?:new\s+)?quote\s+request\s*[-|:]?\s*/i, "").trim() || "Existing quote request");
    if (email.suggested_contact) setContactIds(new Set([email.suggested_contact.id]));
    else setContactIds(new Set());
    if (email.suggested_line_ids.length > 0) setLineIds(new Set(email.suggested_line_ids));
    setNewContactCompany("");
  }

  async function addDetectedContact() {
    if (!selectedExistingEmail?.external_email || !newContactCompany.trim()) return;
    setAddingContact(true);
    setError(null);
    try {
      const response = await fetch("/api/contacts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ company: newContactCompany.trim(), email: selectedExistingEmail.external_email }) });
      const body = await response.json();
      if (!response.ok || !body.contact) throw new Error(body.error ?? "Could not add the contact");
      setContacts((current) => [...current, body.contact].sort((left, right) => left.company.localeCompare(right.company)));
      setContactIds(new Set([body.contact.id]));
      setExistingEmails((current) => current.map((email) => email.id === selectedExistingEmail.id ? { ...email, suggested_contact: body.contact } : email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the contact");
    } finally {
      setAddingContact(false);
    }
  }

  async function dismissSuggestion(email: ExistingQuoteEmail) {
    if (!email.suggestion_id) return;
    const response = await fetch(`/api/projects/${projectId}/quote-requests/import-email`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ suggestion_id: email.suggestion_id, action: "dismiss" }) });
    const body = await response.json();
    if (!response.ok) { setError(body.error ?? "Could not dismiss the suggestion"); return; }
    if (existingEmailId === email.id) setExistingEmailId("");
    setExistingEmails((current) => current.filter((row) => row.id !== email.id));
  }

  async function createAndSend(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || lineIds.size === 0 || contactIds.size === 0 || (sourceMode === "existing" && !existingEmailId)) return;
    setCreating(true);
    setError(null);
    try {
      const response = await fetch(
        sourceMode === "existing" ? `/api/projects/${projectId}/quote-requests/import-email` : `/api/projects/${projectId}/quote-requests`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sourceMode === "existing"
            ? { email_id: existingEmailId, suggestion_id: selectedExistingEmail?.suggestion_id ?? null, title: title.trim(), scope: scope.trim() || null, line_ids: [...lineIds], contact_id: [...contactIds][0] }
            : { title: title.trim(), scope: scope.trim() || null, requested_quote_date: requestedDate || null, line_ids: [...lineIds], contact_ids: [...contactIds] }),
        }
      );
      const body = await response.json();
      if (!response.ok || !body.package) throw new Error(body.error ?? (sourceMode === "existing" ? "Could not link email thread" : "Could not create quote package"));
      if (sourceMode === "new" && files.length > 0) {
        const form = new FormData();
        files.forEach((file) => form.append("files", file));
        const upload = await fetch(`/api/quote-packages/${body.package.id}/attachments`, { method: "POST", body: form });
        const uploadBody = await upload.json();
        if (!upload.ok) throw new Error(uploadBody.error ?? "Could not upload quote attachments");
      }
      if (sourceMode === "new") {
        const send = await fetch(`/api/quote-packages/${body.package.id}/send`, { method: "POST" });
        const sendBody = await send.json();
        if (!send.ok) throw new Error(sendBody.error ?? sendBody.errors?.join("; ") ?? "Could not send quote requests");
        if (sendBody.errors?.length) setError(`Some requests need attention: ${sendBody.errors.join("; ")}`);
      }
      setTitle(""); setScope(""); setRequestedDate(""); setLineIds(new Set()); setContactIds(new Set()); setFiles([]); setExistingEmailId("");
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
    if (!response.ok) { setError(body.error ?? "Could not update quote request"); return false; }
    await load();
    onEstimateReload();
    return true;
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
        <div><p className="label-caps">New quote package</p><p className="mt-1 text-body text-charcoal/60">Choose the work once, then choose one or more trades to price it. Every trade gets a separate tracked thread linked to the same estimate lines.</p></div>
        <div className="inline-flex border border-[#c9c2b4] bg-white p-1"><button type="button" onClick={() => { setSourceMode("new"); setExistingEmailId(""); }} className={sourceMode === "new" ? "bg-nearblack px-3 py-1.5 text-caption text-white" : "px-3 py-1.5 text-caption text-charcoal"}>Send a new request</button><button type="button" onClick={() => { setSourceMode("existing"); setContactIds((current) => new Set([...current].slice(0, 1))); }} className={sourceMode === "existing" ? "bg-nearblack px-3 py-1.5 text-caption text-white" : "px-3 py-1.5 text-caption text-charcoal"}>Link an existing email</button></div>
        {sourceMode === "existing" && <fieldset><legend className="label-caps mb-2">Choose an existing project email</legend><div className="max-h-72 overflow-y-auto border border-[#dcd6cc] bg-white">{existingEmails.map((email) => <div key={email.id} className="flex gap-3 border-b border-[#e5e0d6] px-3 py-3 text-body last:border-0"><input type="radio" name="existing-email" checked={existingEmailId === email.id} disabled={!email.has_thread_id} onChange={() => chooseExistingEmail(email)} /><button type="button" onClick={() => chooseExistingEmail(email)} className="min-w-0 flex-1 text-left"><span className="block text-nearblack">{email.subject ?? "No subject"}</span><span className="text-caption text-charcoal/50">{email.direction === "sent" ? `Sent to ${email.to_addrs.join(", ") || email.external_email || "recipient not yet indexed"}` : `From ${email.from_addr}`} · {new Date(email.received_at).toLocaleDateString("en-AU")}{email.suggested_contact ? ` · ${email.suggested_contact.company}` : email.external_email ? ` · ${email.external_email} is not in Address Book` : ""}</span>{email.suggestion_id && <span className="mt-1 block text-caption text-sand">System match · {Math.round(email.project_confidence * 100)}% project confidence{email.line_candidates.length ? ` · ${email.line_candidates.length} possible estimate line${email.line_candidates.length === 1 ? "" : "s"}` : " · choose an estimate line"}</span>}{email.line_candidates.length > 0 && <span className="mt-1 block text-caption text-charcoal/55">{email.line_candidates.slice(0, 3).map((line) => `${line.description} ${Math.round(line.confidence * 100)}%`).join(" · ")}</span>}</button>{email.suggestion_id && <button type="button" onClick={() => void dismissSuggestion(email)} className="self-start px-1 text-caption text-charcoal/45 hover:text-nearblack">Dismiss</button>}</div>)}{existingEmails.length === 0 && <p className="p-4 text-body text-charcoal/50">No unlinked quote or pricing emails were found for this project.</p>}</div>{selectedExistingEmail?.external_email && !selectedExistingEmail.suggested_contact && <div className="mt-3 border border-[#d7b96f] bg-[#fffaf0] p-3"><p className="text-body text-nearblack">The email address <span className="font-medium">{selectedExistingEmail.external_email}</span> is not in the Address Book yet.</p><div className="mt-2 flex flex-wrap gap-2"><input value={newContactCompany} onChange={(event) => setNewContactCompany(event.target.value)} placeholder="Company or trade name" className="min-w-56 flex-1 border border-[#c9c2b4] bg-white px-3 py-2 text-body" /><button type="button" disabled={addingContact || !newContactCompany.trim()} onClick={() => void addDetectedContact()} className="bg-nearblack px-4 py-2 text-caption text-white disabled:opacity-40">{addingContact ? "Adding…" : "Add to Address Book"}</button></div></div>}</fieldset>}
        <div className="grid gap-4 md:grid-cols-2">
          <label><span className="label-caps">Package title</span><input required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Windows & Doors" className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>
          {sourceMode === "new" && <label><span className="label-caps">Requested quote date</span><input type="date" value={requestedDate} onChange={(event) => setRequestedDate(event.target.value)} className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>}
        </div>
        <label className="block"><span className="label-caps">Scope and instructions</span><textarea value={scope} onChange={(event) => setScope(event.target.value)} rows={4} className="mt-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" /></label>
        <div className="grid gap-5 lg:grid-cols-2">
          <fieldset>
            <legend className="sr-only">Estimate lines</legend><div className="mb-2 flex items-end justify-between gap-3"><p className="label-caps">Estimate lines</p><span className="text-caption text-sand">{lineIds.size} selected</span></div>
            <input type="search" value={lineSearch} onChange={(event) => setLineSearch(event.target.value)} placeholder="Search trade or estimate line" className="mb-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" />
            <div className="max-h-80 overflow-y-auto border border-[#dcd6cc] bg-white">
              {lineGroups.map((section) => {
                const sectionLineIds = section.lines.map((line) => line.id);
                const selectedCount = sectionLineIds.filter((id) => lineIds.has(id)).length;
                return <div key={section.id} className="border-b border-[#dcd6cc] last:border-0"><button type="button" onClick={() => toggleSection(sectionLineIds)} className="flex w-full items-center justify-between bg-cream px-3 py-2 text-left"><span className="label-caps">{section.name}</span><span className="text-caption text-charcoal/55">{selectedCount ? `${selectedCount}/${section.lines.length} selected` : "Select section"}</span></button>{section.lines.map((line) => <label key={line.id} className="flex gap-3 border-t border-[#eee9e0] px-3 py-2 text-body"><input type="checkbox" checked={lineIds.has(line.id)} onChange={() => toggle(setLineIds, line.id)} /><span><span className="block text-nearblack">{line.description}</span>{line.contact_id && <span className="text-caption text-sand">Linked trade will be preselected when opened from this line</span>}</span></label>)}</div>;
              })}
              {lineGroups.length === 0 && <p className="p-4 text-body text-charcoal/50">No estimate lines match that search.</p>}
            </div>
          </fieldset>
          <fieldset>
            <legend className="sr-only">Trades and suppliers</legend><div className="mb-2 flex items-end justify-between gap-3"><p className="label-caps">{sourceMode === "existing" ? "Trade or supplier" : "Trades and suppliers"}</p><span className="text-caption text-sand">{contactIds.size} selected</span></div>
            <input type="search" value={contactSearch} onChange={(event) => setContactSearch(event.target.value)} placeholder="Search company, person or trade" className="mb-2 w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body" />
            {contactIds.size > 0 && <div className="mb-2 flex flex-wrap gap-1">{contacts.filter((contact) => contactIds.has(contact.id)).map((contact) => <button key={contact.id} type="button" onClick={() => toggleContact(contact.id)} className="border border-sand bg-cream px-2 py-1 text-caption text-sand">{contact.company} ×</button>)}</div>}
            <div className="max-h-80 overflow-y-auto border border-[#dcd6cc] bg-white">{filteredContacts.map((contact) => <label key={contact.id} className="flex gap-3 border-b border-[#e5e0d6] px-3 py-2 text-body last:border-0"><input type={sourceMode === "existing" ? "radio" : "checkbox"} name={sourceMode === "existing" ? "quote-contact" : undefined} checked={contactIds.has(contact.id)} onChange={() => toggleContact(contact.id)} /><span><span className="block text-nearblack">{contact.company}</span><span className="text-caption text-charcoal/50">{[contact.contact_name, contact.specialty, contact.email].filter(Boolean).join(" · ")}</span></span></label>)}{filteredContacts.length === 0 && <p className="p-4 text-body text-charcoal/50">No Address Book contacts match that search.</p>}</div>
          </fieldset>
        </div>
        {sourceMode === "new" && <label className="block"><span className="label-caps">Images, drawings and documents</span><input type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} className="mt-2 block w-full text-body" />{files.length > 0 && <span className="mt-1 block text-caption text-charcoal/55">{files.map((file) => file.name).join(" · ")}</span>}</label>}
        <button disabled={creating || !title.trim() || lineIds.size === 0 || contactIds.size === 0 || (sourceMode === "existing" && !existingEmailId)} className="bg-nearblack px-5 py-2.5 text-subhead text-white disabled:opacity-40">{creating ? (sourceMode === "existing" ? "Linking thread…" : "Creating and sending…") : sourceMode === "existing" ? "Link email thread to estimate" : `Create and send ${contactIds.size || ""} request${contactIds.size === 1 ? "" : "s"}`}</button>
      </form>

      <section className="space-y-4">
        <div><p className="label-caps">Quote register</p><p className="mt-1 text-caption text-charcoal/55">Email replies, promised dates and submitted files stay attached to their package and every included estimate line.</p></div>
        {loading ? <p className="text-body text-charcoal/50">Loading quote requests…</p> : packages.length === 0 ? <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/50">No quote requests yet.</p> : packages.map((quotePackage) => (
          <article key={quotePackage.id} id={`quote-package-${quotePackage.id}`} className="border border-[#dcd6cc] bg-white">
            <header className="flex flex-wrap items-start justify-between gap-3 bg-cream px-4 py-3"><div><h3 className="font-display text-subhead text-nearblack">{quotePackage.title}</h3><p className="mt-1 text-caption text-charcoal/55">{quotePackage.lines.map((line) => line.description_snapshot).join(" · ")}</p></div><div className="flex items-center gap-2">{quotePackage.requests.some((request) => request.status === "draft") && <button type="button" disabled={sendingPackageId === quotePackage.id} onClick={() => retryPackage(quotePackage.id)} className="border border-nearblack px-2 py-1 text-caption disabled:opacity-40">{sendingPackageId === quotePackage.id ? "Sending…" : "Send remaining"}</button>}<span className="label-caps border border-sand px-2 py-1 text-sand">{quotePackage.status}</span></div></header>
            {quotePackage.attachments.filter((file) => file.kind === "request").length > 0 && <div className="flex flex-wrap gap-2 border-b border-[#e5e0d6] px-4 py-3">{quotePackage.attachments.filter((file) => file.kind === "request").map((file) => <a key={file.id} href={file.url ?? "#"} target="_blank" rel="noreferrer" className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal hover:border-nearblack">{file.filename}</a>)}</div>}
            <div className="divide-y divide-[#e5e0d6]">{quotePackage.requests.map((request) => (
              <div key={request.id} className="space-y-3 px-4 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-body font-medium text-nearblack">{request.contact?.company ?? request.sent_to_email ?? "Supplier"}</p><p className="text-caption text-charcoal/55">{requestLabel(request)}{request.quote_amount_ex_gst !== null ? ` · ${formatMoney(request.quote_amount_ex_gst)} ex GST` : ""}</p></div><div className="flex flex-wrap gap-2">{["sent", "acknowledged"].includes(request.status) && <button type="button" onClick={() => followUp(request.id)} className="border border-[#c9c2b4] px-2 py-1 text-caption">Send follow-up</button>}</div></div>
                {request.status === "acknowledged" && !request.promised_quote_at && <label className="flex flex-wrap items-center gap-2 text-caption text-charcoal/60">Promised date <input type="date" onChange={(event) => event.target.value && updateRequest(request.id, { promised_quote_at: event.target.value })} className="border border-[#c9c2b4] px-2 py-1" /></label>}
                {request.response_note && <p className="whitespace-pre-wrap border-l-2 border-sand pl-3 text-body text-charcoal/70">{request.response_note}</p>}
                {request.response_lines.length > 0 && <div className="grid gap-1 text-caption">{request.response_lines.map((responseLine) => { const line = quotePackage.lines.find((item) => item.id === responseLine.package_line_id); return <div key={responseLine.package_line_id} className="flex justify-between gap-3"><span>{line?.description_snapshot ?? "Line item"}</span><span>{responseLine.amount_ex_gst === null ? "—" : `${formatMoney(responseLine.amount_ex_gst)} ex GST`}</span></div>; })}</div>}
                {quotePackage.attachments.filter((file) => file.request_id === request.id && file.kind === "response").map((file) => <a key={file.id} href={file.url ?? "#"} target="_blank" rel="noreferrer" className="mr-2 inline-block border border-[#c9c2b4] px-2 py-1 text-caption">{file.filename}</a>)}
                {request.emails.length > 0 && <details><summary className="cursor-pointer text-caption text-sand">Email history ({request.emails.length})</summary><div className="mt-2 space-y-2">{request.emails.map((email) => <div key={email.id} className="border border-[#e5e0d6] bg-offwhite p-3"><p className="text-caption text-charcoal/50">{email.direction === "inbound" ? "From" : "Sent"} {email.from_addr} · {new Date(email.received_at).toLocaleDateString("en-AU")}</p><p className="mt-1 text-body font-medium">{email.subject}</p>{email.clean_text && <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-caption text-charcoal/70">{email.clean_text}</p>}{email.attachments.length > 0 && <p className="mt-2 text-caption text-sand">Attachments: {email.attachments.map((file) => file.filename).join(", ")}</p>}</div>)}</div></details>}
                {!["draft", "declined", "closed"].includes(request.status) && <QuoteResponseEditor quotePackage={quotePackage} request={request} onSave={(patch) => updateRequest(request.id, patch)} />}
              </div>
            ))}</div>
          </article>
        ))}
      </section>
    </div>
  );
}

function QuoteResponseEditor({ quotePackage, request, onSave }: { quotePackage: SupplierQuotePackage; request: SupplierQuoteRequest; onSave: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const existingAmounts = useMemo(() => new Map(request.response_lines.map((line) => [line.package_line_id, line.amount_ex_gst])), [request.response_lines]);
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState(request.quote_reference ?? "");
  const [note, setNote] = useState(request.response_note ?? "");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => Object.fromEntries(quotePackage.lines.map((line) => [line.id, existingAmounts.get(line.id) === null || existingAmounts.get(line.id) === undefined ? "" : String(existingAmounts.get(line.id))])));
  const [saving, setSaving] = useState(false);
  const fullyAllocated = quotePackage.lines.length > 0 && quotePackage.lines.every((line) => typeof existingAmounts.get(line.id) === "number");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setReference(request.quote_reference ?? "");
      setNote(request.response_note ?? "");
      setAmounts(Object.fromEntries(quotePackage.lines.map((line) => [line.id, existingAmounts.get(line.id) === null || existingAmounts.get(line.id) === undefined ? "" : String(existingAmounts.get(line.id))])));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [existingAmounts, quotePackage.lines, request.quote_reference, request.response_note]);

  async function saveQuote() {
    setSaving(true);
    try {
      const ok = await onSave({
        status: "quote_received",
        quote_reference: reference.trim() || null,
        response_note: note.trim() || null,
        response_lines: quotePackage.lines.map((line) => ({
          package_line_id: line.id,
          amount_ex_gst: amounts[line.id]?.trim() ? Number(amounts[line.id]) : null,
        })),
      });
      if (ok) setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return <div className="border border-[#dcd6cc] bg-offwhite p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><p className="label-caps">Quote costing</p><p className="text-caption text-charcoal/55">Allocate the supplier&apos;s ex GST figure to every included estimate line before selecting it.</p></div>
      <div className="flex gap-2"><button type="button" onClick={() => setOpen((value) => !value)} className="border border-[#c9c2b4] px-2 py-1 text-caption">{open ? "Close" : request.status === "quote_received" ? "Edit costs" : "Record quote"}</button>{request.status === "quote_received" && <button type="button" disabled={!fullyAllocated} title={fullyAllocated ? "Write this supplier and these costs into the estimate" : "Enter an amount for every estimate line first"} onClick={() => onSave({ status: "selected" })} className="bg-nearblack px-3 py-1 text-caption text-white disabled:opacity-35">Select quote</button>}</div>
    </div>
    {request.status === "quote_received" && !fullyAllocated && <p className="mt-2 text-caption text-[#76570a]">Quote received, but the cost breakdown is incomplete. It cannot update Finance yet.</p>}
    {open && <div className="mt-3 space-y-3">
      <label className="block"><span className="label-caps">Quote reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} className="mt-1 w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
      <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-white">{quotePackage.lines.map((line) => <label key={line.id} className="grid gap-2 px-3 py-2 sm:grid-cols-[1fr_150px] sm:items-center"><span className="text-body text-charcoal">{line.description_snapshot}</span><span className="flex items-center gap-1"><span className="text-caption text-charcoal/45">$</span><input type="number" min="0" step="0.01" value={amounts[line.id] ?? ""} onChange={(event) => setAmounts((current) => ({ ...current, [line.id]: event.target.value }))} placeholder="Ex GST" className="w-full border border-[#c9c2b4] px-2 py-1 text-right text-body" /></span></label>)}</div>
      <label className="block"><span className="label-caps">Internal note</span><textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="mt-1 w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
      <button type="button" disabled={saving} onClick={saveQuote} className="bg-nearblack px-4 py-2 text-caption text-white disabled:opacity-40">{saving ? "Saving…" : "Save quote details"}</button>
    </div>}
  </div>;
}
