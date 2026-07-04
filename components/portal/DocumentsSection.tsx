import type { PortalDocument } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

const KIND_LABELS: Record<PortalDocument["kind"], string> = {
  plans: "Plans",
  council: "Council approvals",
  engineering: "Engineering",
  scope_of_works: "Scope of works",
  other: "Other",
};

const KIND_ORDER: PortalDocument["kind"][] = [
  "plans",
  "council",
  "engineering",
  "scope_of_works",
  "other",
];

/**
 * Documents section (BUILD-SPEC.md "Week 8 — Client portal expansion":
 * "Documents (project_files where share_to_portal, grouped by kind,
 * signed URLs)"). Read-only list — signing happens in the Contracts
 * section below via a link to the dedicated sign page, so a document
 * requiring a signature appears in BOTH places (Documents for browsing/
 * download, Contracts for the actionable signing queue), matching how
 * the spec separates "Documents" from "Contracts & signatures" as two
 * distinct sections.
 */
export function DocumentsSection({ documents }: { documents: PortalDocument[] }) {
  if (documents.length === 0) {
    return (
      <PortalSection id="documents" title="Documents">
        <p className="text-body text-charcoal/50">
          No documents have been shared yet.
        </p>
      </PortalSection>
    );
  }

  const byKind = new Map<PortalDocument["kind"], PortalDocument[]>();
  for (const doc of documents) {
    const list = byKind.get(doc.kind) ?? [];
    list.push(doc);
    byKind.set(doc.kind, list);
  }

  return (
    <PortalSection id="documents" title="Documents">
      <div className="space-y-6">
        {KIND_ORDER.filter((k) => byKind.has(k)).map((kind) => (
          <div key={kind}>
            <h3 className="text-subhead mb-2 text-nearblack">{KIND_LABELS[kind]}</h3>
            <ul className="space-y-1">
              {byKind.get(kind)!.map((doc) => (
                <li key={doc.id} className="flex items-center justify-between gap-3 border-b border-[#e5e0d6] py-2">
                  <a
                    href={doc.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-body text-nearblack underline decoration-sand underline-offset-2 hover:decoration-nearblack"
                  >
                    {doc.revision_label && (
                      <span className="label-caps mr-2 !text-sand">{doc.revision_label}</span>
                    )}
                    {doc.filename}
                  </a>
                  <span className="shrink-0 text-caption text-charcoal/40">
                    {new Date(doc.uploaded_at).toLocaleDateString("en-AU")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </PortalSection>
  );
}
