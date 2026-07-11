"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { SiteCaptureWithUrl } from "@/types/site-captures";
import { adelaideDateKey, adelaideDayLabel, adelaideTimeLabel } from "@/lib/site-captures";

const KIND_LABEL: Record<string, string> = { photo: "Photo", note: "Note", audio: "Voice note" };

/**
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 4 —
 * "Site diary": reverse-chronological captures, date-stamped
 * (Adelaide), photo thumbnails (click -> full, signed URL), notes as
 * text, audio rows with an <audio> player + transcript below when
 * done ('Transcription pending — Aria' pill while pending), grouped
 * by day. Fed by GET /api/projects/[id]/site-captures, which is
 * already newest-first — grouping into a Map preserves that order per
 * day-group without a separate sort.
 */
export function SiteDiary({ projectId }: { projectId: string }) {
  const [captures, setCaptures] = useState<SiteCaptureWithUrl[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/site-captures`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error ?? "Could not load the site diary.");
        }
        return res.json();
      })
      .then((body) => {
        if (!cancelled) setCaptures(body.captures ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the site diary.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (!lightboxUrl) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLightboxUrl(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightboxUrl]);

  const groups = useMemo(() => {
    if (!captures) return [];
    const map = new Map<string, SiteCaptureWithUrl[]>();
    for (const c of captures) {
      const key = adelaideDateKey(c.created_at);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()];
  }, [captures]);

  if (error) {
    return <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>;
  }

  if (!captures) {
    return <p className="text-body text-charcoal/50">Loading…</p>;
  }

  if (captures.length === 0) {
    return (
      <div className="border border-dashed border-[#c9c2b4] p-10 text-center">
        <p className="text-body text-charcoal/60">
          Nothing captured yet. Use /capture on site, or the capture section on a trade&apos;s confirmation page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {groups.map(([dateKey, dayCaptures]) => (
        <section key={dateKey}>
          <h2 className="label-caps mb-3 border-b border-nearblack pb-2">{adelaideDayLabel(dateKey)}</h2>
          <ul className="space-y-3">
            {dayCaptures.map((c) => (
              <li key={c.id} className="border border-[#dcd6cc] bg-offwhite px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="label-caps !text-sand">{KIND_LABEL[c.kind] ?? c.kind}</span>
                  <span className="text-caption text-charcoal/50">
                    {adelaideTimeLabel(c.created_at)}
                    {c.author && <> · {c.author.label}</>}
                  </span>
                </div>

                {c.kind === "photo" && (c.thumb_url || c.url) && (
                  <button
                    type="button"
                    onClick={() => setLightboxUrl(c.url ?? c.thumb_url)}
                    className="relative mt-2 block h-32 w-32 overflow-hidden bg-cream"
                  >
                    <Image src={(c.thumb_url ?? c.url) as string} alt="Site photo" fill sizes="128px" className="object-cover" />
                  </button>
                )}

                {c.kind === "note" && (
                  <p className="mt-2 whitespace-pre-wrap text-body text-nearblack">{c.text_content}</p>
                )}

                {c.kind === "audio" && (
                  <div className="mt-2 space-y-2">
                    {c.url && (
                      // eslint-disable-next-line jsx-a11y/media-has-caption
                      <audio controls src={c.url} className="w-full" />
                    )}
                    {c.transcript_status === "done" && c.transcript ? (
                      <p className="text-body text-nearblack">{c.transcript}</p>
                    ) : c.transcript_status === "failed" ? (
                      <span className="inline-block border border-red-700/40 bg-red-50 px-2 py-0.5 text-caption text-red-700">
                        Transcription failed
                      </span>
                    ) : (
                      <span className="inline-block border border-[#c9c2b4] px-2 py-0.5 text-caption text-charcoal/60">
                        Transcription pending — Aria
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-nearblack/80 p-6"
          onClick={() => setLightboxUrl(null)}
        >
          <div className="relative h-[80vh] w-[90vw] max-w-3xl" onClick={(e) => e.stopPropagation()}>
            <Image src={lightboxUrl} alt="Site photo" fill sizes="90vw" className="object-contain" />
            <button
              type="button"
              onClick={() => setLightboxUrl(null)}
              className="absolute -top-10 right-0 border border-white/40 px-3 py-1 text-caption text-white hover:border-white"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
