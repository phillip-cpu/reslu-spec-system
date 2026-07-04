"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectFile, ProjectFileKind } from "@/types";

type FileWithUrl = ProjectFile & { url: string };

const SECTIONS: { kind: ProjectFileKind; label: string }[] = [
  { kind: "plans", label: "Plans" },
  { kind: "council", label: "Council approvals" },
  { kind: "engineering", label: "Engineering" },
  { kind: "scope_of_works", label: "Scope of works" },
  { kind: "other", label: "Other" },
];

interface Props {
  projectId: string;
  currentUserId: string | null;
  isAdmin: boolean;
}

/**
 * /projects/[id]/documents — Project Documents tab (BUILD-SPEC.md
 * "Project documents"). Team-visible, NOT admin-gated — documents
 * aren't financial. Five fixed sections, each newest-revision-first:
 * grouped by kind, sorted revision_label desc then uploaded_at desc,
 * latest visually prominent with older revisions muted beneath.
 *
 * Mirrors components/items/ItemAssets.tsx's upload/list/remove shape,
 * extended with the revision_label field and per-section grouping.
 */
export function ProjectDocuments({ projectId, currentUserId, isAdmin }: Props) {
  const [files, setFiles] = useState<FileWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/files`)
      .then((r) => r.json())
      .then((d) => {
        if (active) setFiles(d.files ?? []);
      })
      .catch(() => active && setError("Could not load documents."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId]);

  async function removeFile(id: string) {
    const prev = files;
    setFiles((cur) => cur.filter((f) => f.id !== id));
    try {
      const res = await fetch(`/api/project-files/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Delete failed");
      }
    } catch (err) {
      setFiles(prev);
      setError(err instanceof Error ? err.message : "Could not remove document");
    }
  }

  function onUploaded(file: FileWithUrl) {
    setFiles((cur) => [file, ...cur]);
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading documents…</p>;
  }

  return (
    <div className="space-y-8">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {SECTIONS.map((section) => (
        <DocumentSection
          key={section.kind}
          projectId={projectId}
          kind={section.kind}
          label={section.label}
          files={files.filter((f) => f.kind === section.kind)}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          onUploaded={onUploaded}
          onRemove={removeFile}
          onError={setError}
        />
      ))}
    </div>
  );
}

function DocumentSection({
  projectId,
  kind,
  label,
  files,
  currentUserId,
  isAdmin,
  onUploaded,
  onRemove,
  onError,
}: {
  projectId: string;
  kind: ProjectFileKind;
  label: string;
  files: FileWithUrl[];
  currentUserId: string | null;
  isAdmin: boolean;
  onUploaded: (file: FileWithUrl) => void;
  onRemove: (id: string) => void;
  onError: (msg: string | null) => void;
}) {
  const [revisionLabel, setRevisionLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Newest-revision-first: group is already scoped to this kind; sort
  // by revision_label desc (string compare — "T3" > "T2" > "T1"; a
  // null label sorts after any labelled revision) then uploaded_at desc.
  const sorted = [...files].sort((a, b) => {
    if (a.revision_label !== b.revision_label) {
      if (a.revision_label === null) return 1;
      if (b.revision_label === null) return -1;
      return b.revision_label.localeCompare(a.revision_label);
    }
    return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
  });
  const [latest, ...older] = sorted;

  async function upload(file: File) {
    setUploading(true);
    onError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      if (revisionLabel.trim()) fd.append("revision_label", revisionLabel.trim());
      const res = await fetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { file: row } = await res.json();
      onUploaded(row);
      setRevisionLabel("");
      if (fileInput.current) fileInput.current.value = "";
    } catch (err) {
      onError(err instanceof Error ? err.message : "Document upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="border border-[#dcd6cc]">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-cream px-4 py-3">
        <p className="label-caps !text-nearblack">{label}</p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={revisionLabel}
            onChange={(e) => setRevisionLabel(e.target.value)}
            placeholder="T3"
            title="Optional revision label"
            className="w-16 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
          <input
            ref={fileInput}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInput.current?.click()}
            className="border border-nearblack px-3 py-1.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        {sorted.length === 0 ? (
          <p className="text-caption text-charcoal/40">No documents yet.</p>
        ) : (
          <div className="space-y-2">
            <DocumentRow
              file={latest}
              prominent
              canDelete={isAdmin || latest.uploaded_by === currentUserId}
              onRemove={() => onRemove(latest.id)}
            />
            {older.length > 0 && (
              <ul className="space-y-1 border-t border-[#e5e0d6] pt-2">
                {older.map((f) => (
                  <DocumentRow
                    key={f.id}
                    file={f}
                    canDelete={isAdmin || f.uploaded_by === currentUserId}
                    onRemove={() => onRemove(f.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function DocumentRow({
  file,
  prominent,
  canDelete,
  onRemove,
}: {
  file: FileWithUrl;
  prominent?: boolean;
  canDelete: boolean;
  onRemove: () => void;
}) {
  const rowClass = prominent
    ? "flex items-center justify-between gap-2"
    : "flex items-center justify-between gap-2 opacity-50";

  const content = (
    <>
      <a
        href={file.url}
        target="_blank"
        rel="noopener noreferrer"
        download={file.filename}
        className={
          prominent
            ? "truncate text-body text-nearblack underline decoration-charcoal/30 underline-offset-2 hover:decoration-nearblack"
            : "truncate text-caption text-charcoal/70 underline decoration-charcoal/20 underline-offset-2 hover:decoration-charcoal/60"
        }
      >
        {file.revision_label && (
          <span className="label-caps mr-1 !text-sand">{file.revision_label}</span>
        )}
        {file.filename}
      </a>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-caption text-charcoal/40">
          {new Date(file.uploaded_at).toLocaleDateString("en-AU")}
        </span>
        {canDelete && (
          <button
            type="button"
            onClick={onRemove}
            className="text-caption text-charcoal/50 hover:text-red-700"
          >
            Remove
          </button>
        )}
      </div>
    </>
  );

  if (prominent) {
    return <div className={rowClass}>{content}</div>;
  }
  return <li className={rowClass}>{content}</li>;
}
