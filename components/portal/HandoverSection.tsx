import Image from "next/image";
import type { PortalHandoverPack } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

/**
 * Handover section (BUILD-SPEC.md §"Phase 11 additions — confirmed by
 * Phillip" point 4): "when project status -> completed, portal gains a
 * Handover section: curated manuals & warranties (item_files of kind
 * install_manual + new kind 'warranty'), compliance certificates
 * (project_files kind addition 'certificate'), final gallery (published
 * photos), final documents." Renders ONLY when the page passes a pack
 * (the page itself only builds/passes one when project.status ===
 * 'completed' — see app/portal/[token]/page.tsx).
 */
export function HandoverSection({ pack }: { pack: PortalHandoverPack }) {
  const isEmpty =
    pack.manuals_and_warranties.length === 0 &&
    pack.certificates.length === 0 &&
    pack.documents.length === 0 &&
    pack.gallery.length === 0;

  return (
    <PortalSection id="handover" title="Handover">
      <p className="mb-6 text-body text-charcoal/70">
        Your project is complete. Everything you need to look after your new space, in one place.
      </p>

      {isEmpty ? (
        <p className="text-body text-charcoal/50">Your handover pack is being prepared — check back soon.</p>
      ) : (
        <div className="space-y-8">
          {pack.manuals_and_warranties.length > 0 && (
            <div>
              <h3 className="text-subhead mb-2 text-nearblack">Manuals &amp; warranties</h3>
              <FileList files={pack.manuals_and_warranties} />
            </div>
          )}

          {pack.certificates.length > 0 && (
            <div>
              <h3 className="text-subhead mb-2 text-nearblack">Compliance certificates</h3>
              <FileList files={pack.certificates} />
            </div>
          )}

          {pack.documents.length > 0 && (
            <div>
              <h3 className="text-subhead mb-2 text-nearblack">Documents</h3>
              <FileList files={pack.documents} />
            </div>
          )}

          {pack.gallery.length > 0 && (
            <div>
              <h3 className="text-subhead mb-2 text-nearblack">Final gallery</h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {pack.gallery.map((p) => (
                  <div key={p.id} className="relative aspect-square overflow-hidden bg-cream">
                    <Image src={p.url} alt={p.caption ?? ""} fill sizes="220px" className="object-cover" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </PortalSection>
  );
}

function FileList({ files }: { files: PortalHandoverPack["manuals_and_warranties"] }) {
  return (
    <ul className="space-y-1">
      {files.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-3 border-b border-[#e5e0d6] py-2">
          <a
            href={f.url}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate text-body text-nearblack underline decoration-sand underline-offset-2 hover:decoration-nearblack"
          >
            {f.item_name && <span className="label-caps mr-2 !text-sand">{f.item_name}</span>}
            {f.filename}
          </a>
        </li>
      ))}
    </ul>
  );
}
