"use client";

import { useState } from "react";
import clsx from "clsx";

interface FileRow {
  id: string;
  kind: string;
  filename: string;
  revision_label: string | null;
  share_to_portal: boolean;
  uploaded_at: string;
}

interface RequestRow {
  id: string;
  subject_type: "project_file" | "variation" | "sow";
  subject_id: string;
  status: "pending" | "signed" | "void";
  voided_reason: string | null;
  created_at: string;
}

/**
 * Contract flow panel (BUILD-SPEC.md "Team-side client area": "contract
 * flow (pick a project_file → 'Request signature' creates
 * signature_request); status chips pending/signed/void; view
 * certificate link)". Team-authenticated, not admin-only.
 */
export function ContractsPanel({
  projectId,
  files,
  requests: initialRequests,
  onChange,
}: {
  projectId: string;
  files: FileRow[];
  requests: RequestRow[];
  onChange: () => void;
}) {
  const [requests, setRequests] = useState(initialRequests);
  const [fileShares, setFileShares] = useState(files);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [certUrls, setCertUrls] = useState<Record<string, string | null>>({});
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);

  async function toggleFileShare(id: string, share: boolean) {
    setShareBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/files/${id}/share`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ share_to_portal: share }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update sharing");
      setFileShares((cur) => cur.map((f) => (f.id === id ? { ...f, share_to_portal: share } : f)));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update sharing");
    } finally {
      setShareBusyId(null);
    }
  }

  const requestsByFile = new Map<string, RequestRow[]>();
  for (const r of requests) {
    if (r.subject_type !== "project_file") continue;
    const list = requestsByFile.get(r.subject_id) ?? [];
    list.push(r);
    requestsByFile.set(r.subject_id, list);
  }

  async function requestSignature() {
    if (!selectedFileId) return;
    setRequesting(true);
    setError(null);
    try {
      const res = await fetch(`/api/signatures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, subject_type: "project_file", subject_id: selectedFileId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not create signature request");
      const { request } = await res.json();
      setRequests((cur) => [request, ...cur]);
      setSelectedFileId("");
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create signature request");
    } finally {
      setRequesting(false);
    }
  }

  async function voidRequest(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/signatures/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "void", reason: "Document superseded by a new revision." }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not void request");
      const { request } = await res.json();
      setRequests((cur) => cur.map((r) => (r.id === id ? request : r)));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not void request");
    }
  }

  async function viewCertificate(id: string) {
    if (certUrls[id] !== undefined) return;
    try {
      const res = await fetch(`/api/signatures/${id}`);
      const data = await res.json();
      setCertUrls((cur) => ({ ...cur, [id]: data.certificate_url ?? null }));
      if (data.certificate_url) window.open(data.certificate_url, "_blank", "noopener,noreferrer");
    } catch {
      setCertUrls((cur) => ({ ...cur, [id]: null }));
    }
  }

  // Only files with no active (pending/signed) request are offered in
  // the picker — re-requesting against an already-requested file
  // should go through "supersede" (void the old one) rather than
  // silently stacking duplicate requests.
  const availableFiles = fileShares.filter((f) => {
    const existing = requestsByFile.get(f.id) ?? [];
    return !existing.some((r) => r.status === "pending" || r.status === "signed");
  });

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <div>
        <p className="label-caps mb-2 !text-sand">Shared documents</p>
        {fileShares.length === 0 ? (
          <p className="text-body text-charcoal/50">No documents uploaded yet — add some from the Documents tab first.</p>
        ) : (
          <ul className="space-y-1">
            {fileShares.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 border-b border-[#e5e0d6] py-2">
                <span className="truncate text-body text-charcoal/80">
                  {f.revision_label && <span className="label-caps mr-2 !text-sand">{f.revision_label}</span>}
                  {f.filename}
                </span>
                <label className="flex shrink-0 items-center gap-2 text-caption text-charcoal/60">
                  <input
                    type="checkbox"
                    checked={f.share_to_portal}
                    disabled={shareBusyId === f.id}
                    onChange={(e) => toggleFileShare(f.id, e.target.checked)}
                  />
                  Share to portal
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 border border-[#dcd6cc] bg-nearwhite px-4 py-3">
        <div className="min-w-[220px] flex-1">
          <label className="label-caps mb-1 block !text-sand">Document</label>
          <select
            value={selectedFileId}
            onChange={(e) => setSelectedFileId(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="">Select a document…</option>
            {availableFiles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.revision_label ? `${f.revision_label} — ` : ""}
                {f.filename}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          disabled={!selectedFileId || requesting}
          onClick={requestSignature}
          className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
        >
          {requesting ? "Requesting…" : "Request signature"}
        </button>
      </div>

      <div>
        <p className="label-caps mb-2 !text-sand">Signature requests</p>
        {requests.filter((r) => r.subject_type === "project_file").length === 0 ? (
          <p className="text-body text-charcoal/50">No signature requests yet.</p>
        ) : (
          <ul className="space-y-2">
            {requests
              .filter((r) => r.subject_type === "project_file")
              .map((r) => {
                const file = fileShares.find((f) => f.id === r.subject_id);
                return (
                  <li key={r.id} className="flex items-center justify-between gap-3 border border-[#e5e0d6] bg-nearwhite px-4 py-3">
                    <div>
                      <p className="text-subhead text-nearblack">{file?.filename ?? "Document (superseded)"}</p>
                      {r.status === "void" && r.voided_reason && (
                        <p className="mt-1 text-caption text-charcoal/50">{r.voided_reason}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <span
                        className={clsx(
                          "label-caps px-3 py-1.5",
                          r.status === "signed"
                            ? "bg-sand text-white"
                            : r.status === "void"
                              ? "border border-charcoal/30 text-charcoal/50"
                              : "border border-nearblack text-nearblack"
                        )}
                      >
                        {r.status}
                      </span>
                      {r.status === "signed" && (
                        <button
                          type="button"
                          onClick={() => viewCertificate(r.id)}
                          className="text-caption text-charcoal/60 underline hover:text-nearblack"
                        >
                          View certificate
                        </button>
                      )}
                      {r.status === "pending" && (
                        <button
                          type="button"
                          onClick={() => voidRequest(r.id)}
                          className="text-caption text-charcoal/50 hover:text-red-700"
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
          </ul>
        )}
      </div>
    </div>
  );
}
