import clsx from "clsx";
import type { PortalSignatureSummary } from "@/app/portal/types";
import { PortalSection } from "@/components/portal/PortalSection";

export interface ContractRow {
  request_id: string;
  subject_type: PortalSignatureSummary["subject_type"];
  filename: string;
  status: PortalSignatureSummary["status"];
  signed_by: string | null;
  signed_at: string | null;
}

/**
 * Contracts & signatures section (BUILD-SPEC.md "Week 8 — Client
 * portal expansion": "Contracts & signatures (signature_requests
 * pending/signed for this project's shared files)"). Pending rows link
 * to the dedicated sign page; signed rows show the "Signed by X on
 * date" badge per BUILD-SPEC.md's signature section.
 */
export function ContractsSection({ token, contracts }: { token: string; contracts: ContractRow[] }) {
  if (contracts.length === 0) {
    return (
      <PortalSection id="contracts" title="Contracts &amp; signatures">
        <p className="text-body text-charcoal/50">
          There is nothing awaiting your signature right now.
        </p>
      </PortalSection>
    );
  }

  return (
    <PortalSection id="contracts" title="Contracts &amp; signatures">
      <div className="space-y-3">
        {contracts.map((c) => (
          <div
            key={c.request_id}
            className="flex flex-col gap-3 border border-[#dcd6cc] bg-nearwhite p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p className="text-subhead text-nearblack">{c.filename}</p>
              {c.status === "signed" && c.signed_by && c.signed_at ? (
                <p className="mt-1 text-body text-charcoal/60">
                  Signed by {c.signed_by} on{" "}
                  {new Date(c.signed_at).toLocaleDateString("en-AU", {
                    timeZone: "Australia/Adelaide",
                    day: "numeric",
                    month: "long",
                    year: "numeric",
                  })}
                </p>
              ) : c.status === "void" ? (
                <p className="mt-1 text-body text-charcoal/60">
                  Superseded — a new signature will be requested.
                </p>
              ) : (
                <p className="mt-1 text-body text-charcoal/60">Awaiting your signature</p>
              )}
            </div>

            {c.status === "pending" ? (
              <a
                href={`/portal/${token}/sign/${c.request_id}`}
                className="shrink-0 bg-nearblack px-4 py-2 text-center text-subhead text-white transition-colors hover:bg-charcoal"
              >
                Review &amp; sign
              </a>
            ) : (
              <span
                className={clsx(
                  "label-caps shrink-0 px-3 py-1.5 text-center",
                  c.status === "signed" ? "bg-sand text-white" : "border border-charcoal/30 text-charcoal/50"
                )}
              >
                {c.status}
              </span>
            )}
          </div>
        ))}
      </div>
    </PortalSection>
  );
}
