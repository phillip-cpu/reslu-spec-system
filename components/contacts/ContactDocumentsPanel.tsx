"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { ASSET_BUCKET } from "@/lib/storage";
import type { ContactDocumentKind, InsuranceStatus } from "@/lib/insurance";
import type { ContactDocumentWithUrl } from "@/types/phase-fix-a";
import type {
  InsuranceRequestKind,
  InsuranceRequestSummary,
} from "@/types/insurance-requests";

interface Props {
  contactId: string;
  contactCompany: string;
  contactEmail: string | null;
  /** Current contacts.insurance_required value (migration 026) — drives the "Certificate needed" checkbox's initial state. */
  insuranceRequired: boolean;
  onCountChange: (count: number) => void;
  onStatusChange: (status: InsuranceStatus) => void;
  /** Fired after a successful PATCH so the parent ContactsBrowser card's badge-visibility check (insurance_required || document_count > 0) stays in sync without a re-fetch. */
  onInsuranceRequiredChange: (required: boolean) => void;
}

const KIND_OPTIONS: { key: ContactDocumentKind; label: string }[] = [
  { key: "public_liability", label: "Public liability" },
  { key: "workers_comp", label: "Workers comp" },
  { key: "licence", label: "Licence" },
  { key: "other", label: "Other" },
];

/**
 * Expandable per-contact documents panel — BUILD-SPEC.md "Trade
 * insurance compliance": upload/list/delete, expiry date input.
 * Rendered by ContactsBrowser.tsx when a contact card is expanded.
 *
 * Upload is the two-step signed-URL flow (POST .../documents/upload-url
 * mints a signed upload URL/token, then the Supabase JS client's
 * storage.uploadToSignedUrl() PUTs the file directly to Storage, then
 * POST .../documents indexes the metadata) — the exact same
 * three-step client sequence components/projects/ProjectDocuments.tsx's
 * upload() already uses for project files, reused here rather than
 * hand-rolling a signed-upload REST call.
 *
 * Re-fetches the contact's own insurance_status after any
 * upload/delete/expiry-date edit (rather than recomputing it
 * client-side) so the badge on ContactsBrowser always reflects exactly
 * what lib/insurance.ts's computeInsuranceStatus would return
 * server-side — GET /api/contacts/[id] returns the same computed
 * fields GET /api/contacts's list does (see that route).
 *
 * Quick items round (6 July 2026), item 1 — "Insurance required flag":
 * also renders a "Certificate needed" checkbox (near the top, above
 * the documents list) that PATCHes contacts.insurance_required
 * (migration 026) via the existing PATCH /api/contacts/[id] route
 * (whitelisted there alongside company/category/etc.). This is now the
 * ONLY way a contact is ever flagged as needing insurance — the old
 * category-based guess (lib/insurance.ts's former
 * isTradeCategory()/TRADE_CATEGORIES) is gone; this column is the
 * single source of truth.
 */
export function ContactDocumentsPanel({
  contactId,
  contactCompany,
  contactEmail,
  insuranceRequired,
  onCountChange,
  onStatusChange,
  onInsuranceRequiredChange,
}: Props) {
  const [documents, setDocuments] = useState<ContactDocumentWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [kind, setKind] = useState<ContactDocumentKind>("public_liability");
  const [expiryDate, setExpiryDate] = useState("");
  const [savingRequired, setSavingRequired] = useState(false);
  const [latestRequest, setLatestRequest] = useState<InsuranceRequestSummary | null>(null);
  const [requestKinds, setRequestKinds] = useState<InsuranceRequestKind[]>([
    "public_liability",
    "workers_comp",
  ]);
  const [sendingRequest, setSendingRequest] = useState(false);
  const [requestMessage, setRequestMessage] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch(`/api/contacts/${contactId}/documents`);
      if (!res.ok) throw new Error("Could not load documents");
      const { documents: docs, latest_request: latestRequestRow } = await res.json();
      setDocuments(docs ?? []);
      setLatestRequest(latestRequestRow ?? null);
      onCountChange((docs ?? []).length);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load documents");
    } finally {
      setLoading(false);
    }
  }

  async function refreshStatus() {
    try {
      const res = await fetch(`/api/contacts/${contactId}`);
      if (!res.ok) return;
      const { contact } = await res.json();
      if (contact?.insurance_status) onStatusChange(contact.insurance_status as InsuranceStatus);
    } catch {
      // Non-fatal — the badge simply won't refresh until the next full list load.
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const urlRes = await fetch(`/api/contacts/${contactId}/documents/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      if (!urlRes.ok) throw new Error((await urlRes.json()).error ?? "Could not start upload");
      const { path, token } = await urlRes.json();

      // Upload DIRECTLY to Supabase Storage (browser -> storage) via the
      // SDK's uploadToSignedUrl — same two-step pattern and same client
      // helper components/projects/ProjectDocuments.tsx's upload() uses,
      // rather than hand-rolling the signed-upload REST URL.
      const supabase = createClient();
      const { error: upErr } = await supabase.storage
        .from(ASSET_BUCKET)
        .uploadToSignedUrl(path, token, file, {
          contentType: file.type || "application/octet-stream",
        });
      if (upErr) throw new Error(upErr.message);

      const metaRes = await fetch(`/api/contacts/${contactId}/documents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          storage_path: path,
          filename: file.name,
          expiry_date: expiryDate || null,
        }),
      });
      if (!metaRes.ok) throw new Error((await metaRes.json()).error ?? "Could not save document");

      setExpiryDate("");
      input.value = "";
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function updateExpiry(id: string, next: string) {
    const prev = documents;
    setDocuments((docs) => docs.map((d) => (d.id === id ? { ...d, expiry_date: next || null } : d)));
    const res = await fetch(`/api/contact-documents/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiry_date: next || null }),
    });
    if (!res.ok) {
      setDocuments(prev);
      setError("Could not update expiry date");
      return;
    }
    await refreshStatus();
  }

  async function remove(id: string) {
    if (!confirm("Delete this document?")) return;
    const prev = documents;
    setDocuments((docs) => docs.filter((d) => d.id !== id));
    const res = await fetch(`/api/contact-documents/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setDocuments(prev);
      setError("Could not delete document");
      return;
    }
    onCountChange(documents.length - 1);
    await refreshStatus();
  }

  async function toggleInsuranceRequired(next: boolean) {
    setSavingRequired(true);
    setError(null);
    onInsuranceRequiredChange(next); // optimistic
    try {
      const res = await fetch(`/api/contacts/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ insurance_required: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      await refreshStatus();
    } catch (err) {
      onInsuranceRequiredChange(!next); // revert
      setError(err instanceof Error ? err.message : "Could not update certificate requirement");
    } finally {
      setSavingRequired(false);
    }
  }

  function toggleRequestKind(kind: InsuranceRequestKind) {
    setRequestKinds((current) =>
      current.includes(kind)
        ? current.filter((value) => value !== kind)
        : [...current, kind]
    );
  }

  async function sendInsuranceRequest() {
    if (!contactEmail || requestKinds.length === 0) return;
    setSendingRequest(true);
    setError(null);
    setRequestMessage(null);
    try {
      const res = await fetch(`/api/contacts/${contactId}/insurance-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: requestKinds }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send the request");
      setLatestRequest(body.request ?? null);
      onInsuranceRequiredChange(true);
      setRequestMessage(`Request sent to ${contactEmail}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request");
    } finally {
      setSendingRequest(false);
    }
  }

  function requestStatus(): string {
    if (!latestRequest) return "";
    if (latestRequest.status === "completed") return "Uploaded";
    if (latestRequest.status === "cancelled") return "Superseded";
    if (new Date(latestRequest.expires_at).getTime() <= Date.now()) return "Link expired";
    if (latestRequest.status === "opened") return "Opened";
    return "Requested";
  }

  function requestDate(): string {
    if (!latestRequest) return "";
    return new Date(latestRequest.requested_at).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  }

  return (
    <div className="border border-[#dcd6cc] bg-nearwhite p-4">
      <label className="mb-3 flex items-center gap-2 border-b border-[#e5e0d6] pb-3 text-body text-charcoal/80">
        <input
          type="checkbox"
          checked={insuranceRequired}
          disabled={savingRequired}
          onChange={(e) => toggleInsuranceRequired(e.target.checked)}
          className="h-4 w-4 border-[#c9c2b4] accent-nearblack disabled:opacity-60"
        />
        Certificate needed
      </label>

      {error && (
        <p className="mb-3 border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>
      )}

      <section className="mb-4 border border-[#dcd6cc] bg-offwhite p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-caps">Request insurance documents</p>
            <p className="mt-1 text-caption text-charcoal/60">
              {contactEmail
                ? `A secure upload link will be emailed to ${contactEmail}.`
                : `Add an email address to ${contactCompany} before sending a request.`}
            </p>
          </div>
          {latestRequest && (
            <div className="text-right">
              <span className="border border-sand px-2 py-1 text-caption uppercase tracking-wide text-sand">
                {requestStatus()}
              </span>
              <p className="mt-1 text-caption text-charcoal/45">{requestDate()}</p>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {([
            ["public_liability", "Public liability"],
            ["workers_comp", "Workers comp"],
            ["licence", "Trade licence"],
          ] as [InsuranceRequestKind, string][]).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-caption text-charcoal/70">
              <input
                type="checkbox"
                checked={requestKinds.includes(value)}
                onChange={() => toggleRequestKind(value)}
                className="h-4 w-4 accent-nearblack"
              />
              {label}
            </label>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={sendInsuranceRequest}
            disabled={!contactEmail || requestKinds.length === 0 || sendingRequest}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-40"
          >
            {sendingRequest
              ? "Sending…"
              : latestRequest
                ? "Send new request"
                : "Send request"}
          </button>
          {requestMessage && (
            <p className="text-caption text-[#46604a]">{requestMessage}</p>
          )}
        </div>
      </section>

      {loading ? (
        <p className="text-caption text-charcoal/50">Loading documents…</p>
      ) : documents.length === 0 ? (
        <p className="mb-3 text-caption text-charcoal/50">No documents on file yet.</p>
      ) : (
        <ul className="mb-3 divide-y divide-[#e5e0d6]">
          {documents.map((doc) => (
            <li key={doc.id} className="flex flex-wrap items-center gap-3 py-2">
              <span className="w-32 shrink-0 text-caption uppercase tracking-wide text-charcoal/50">
                {KIND_OPTIONS.find((k) => k.key === doc.kind)?.label ?? doc.kind}
              </span>
              {doc.url ? (
                <a
                  href={doc.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-body text-nearblack hover:underline"
                >
                  {doc.filename}
                </a>
              ) : (
                <span className="text-body text-charcoal/50">{doc.filename}</span>
              )}
              <label className="ml-auto flex items-center gap-2 text-caption text-charcoal/60">
                Expires
                <input
                  type="date"
                  defaultValue={doc.expiry_date ?? ""}
                  onBlur={(e) => updateExpiry(doc.id, e.target.value)}
                  className="border border-[#c9c2b4] bg-offwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => remove(doc.id)}
                className="text-caption text-charcoal/50 hover:text-red-700"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={upload} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="label-caps">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ContactDocumentKind)}
            className="border border-[#c9c2b4] bg-offwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
          >
            {KIND_OPTIONS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="label-caps">Expiry date</span>
          <input
            type="date"
            value={expiryDate}
            onChange={(e) => setExpiryDate(e.target.value)}
            className="border border-[#c9c2b4] bg-offwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="label-caps">File</span>
          <input
            type="file"
            name="file"
            required
            className="w-full border border-[#c9c2b4] bg-offwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={uploading}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
      </form>
    </div>
  );
}
