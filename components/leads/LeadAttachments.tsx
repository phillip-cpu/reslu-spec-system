"use client";

import { useEffect, useState } from "react";
import type { LeadAttachment } from "@/types";

interface Props {
  leadId: string;
}

type AttachmentWithUrl = LeadAttachment & { url: string | null };

/**
 * Read-only photo strip for a lead's stored attachments — today
 * always the up-to-3 site photos a prospect attached to the
 * reslu.com.au /begin form (POST /api/leads/intake, migration 042).
 * Renders nothing at all when the lead has no attachments (most
 * won't), so it costs no vertical space on the panel for the common
 * case. Signed URLs are minted per fetch by the API and expire —
 * fine for a panel that refetches on every open.
 */
export function LeadAttachments({ leadId }: Props) {
  const [attachments, setAttachments] = useState<AttachmentWithUrl[]>([]);

  useEffect(() => {
    let active = true;
    fetch(`/api/leads/${leadId}/attachments`)
      .then((r) => (r.ok ? r.json() : { attachments: [] }))
      .then((d) => active && setAttachments(d.attachments ?? []))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [leadId]);

  if (attachments.length === 0) return null;

  return (
    <div>
      <span className="mb-2 block text-caption uppercase tracking-wide text-warmgray">
        Photos from enquiry
      </span>
      <div className="flex flex-wrap gap-2">
        {attachments.map((a) =>
          a.url ? (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer"
              title={a.filename}
              className="block h-24 w-24 overflow-hidden border border-[#dcd6cc] bg-white"
            >
              {/* Signed, short-TTL URL from the private assets bucket —
                  next/image's loader would re-request via the optimizer
                  and can outlive the signature, so a plain img is
                  deliberate here (same reasoning as portal photo tiles). */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={a.filename} className="h-full w-full object-cover" />
            </a>
          ) : (
            <span
              key={a.id}
              title={a.filename}
              className="flex h-24 w-24 items-center justify-center border border-[#dcd6cc] bg-white px-1 text-center text-caption text-warmgray"
            >
              {a.filename}
            </span>
          )
        )}
      </div>
    </div>
  );
}
