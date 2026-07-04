"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { CadenceBanner } from "@/components/client-area/CadenceBanner";
import { ProgressPhotosPanel } from "@/components/client-area/ProgressPhotosPanel";
import { UpdatesPanel } from "@/components/client-area/UpdatesPanel";
import { ContractsPanel } from "@/components/client-area/ContractsPanel";
import { VariationSharingPanel } from "@/components/client-area/VariationSharingPanel";

export interface ClientAreaSummary {
  files: {
    id: string;
    kind: string;
    filename: string;
    revision_label: string | null;
    share_to_portal: boolean;
    uploaded_at: string;
  }[];
  variations: {
    id: string;
    var_number: number;
    description: string;
    cost_ex_gst: number;
    status: string;
    share_to_portal: boolean;
    client_response: "approved" | "declined" | null;
    client_response_note: string | null;
    client_responded_at: string | null;
  }[];
  signature_requests: {
    id: string;
    subject_type: "project_file" | "variation" | "sow";
    subject_id: string;
    status: "pending" | "signed" | "void";
    voided_reason: string | null;
    created_at: string;
  }[];
  updates: {
    id: string;
    title: string;
    published_at: string | null;
    created_at: string;
  }[];
  photo_count: number;
  cadence: {
    last_published_at: string | null;
    days_since_last_update: number | null;
    stale: boolean;
  };
}

const TABS = [
  { key: "photos", label: "Progress photos" },
  { key: "updates", label: "Updates" },
  { key: "contracts", label: "Contracts & signatures" },
  { key: "variations", label: "Variations" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

/**
 * Team-side client area (BUILD-SPEC.md "Team-side client area"):
 * sections to manage progress photos, updates, contract/signature
 * flow, and variation sharing. Tabbed within the page (unlike the
 * project-level tab bar, which is styled links per BUILD-SPEC.md's own
 * steer — this is a sub-page with no deep-linkable sibling routes, so
 * plain client-side tab state is the simpler choice here).
 */
export function ClientAreaWorkspace({
  projectId,
  portalToken,
  isAdmin,
}: {
  projectId: string;
  portalToken: string;
  isAdmin: boolean;
}) {
  const [tab, setTab] = useState<TabKey>("photos");
  const [summary, setSummary] = useState<ClientAreaSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/summary`);
      if (!res.ok) throw new Error("Could not load the client area.");
      const data = await res.json();
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the client area.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const portalUrl = typeof window !== "undefined" ? `${window.location.origin}/portal/${portalToken}` : `/portal/${portalToken}`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border border-[#dcd6cc] bg-nearwhite px-4 py-3">
        <p className="text-body text-charcoal/70">
          Client portal:{" "}
          <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="underline decoration-sand underline-offset-2 hover:decoration-nearblack">
            {portalUrl}
          </a>
        </p>
      </div>

      {summary && <CadenceBanner cadence={summary.cadence} />}

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <nav className="flex flex-wrap gap-2 border-b border-[#dcd6cc]">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={clsx(
              "border-b-2 px-3 py-2 text-subhead transition-colors",
              tab === t.key ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/60 hover:text-nearblack"
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {loading ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : (
        <>
          {tab === "photos" && <ProgressPhotosPanel projectId={projectId} />}
          {tab === "updates" && summary && (
            <UpdatesPanel projectId={projectId} initialUpdates={summary.updates} onChange={reload} />
          )}
          {tab === "contracts" && summary && (
            <ContractsPanel
              projectId={projectId}
              files={summary.files}
              requests={summary.signature_requests}
              onChange={reload}
            />
          )}
          {tab === "variations" && summary && (
            <VariationSharingPanel
              projectId={projectId}
              variations={summary.variations}
              isAdmin={isAdmin}
              onChange={reload}
            />
          )}
        </>
      )}
    </div>
  );
}
