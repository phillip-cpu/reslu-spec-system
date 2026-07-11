"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { SiteCaptureWithUrl } from "@/types/site-captures";
import { adelaideDateKey } from "@/lib/site-captures";
import { PhotoCapture } from "./PhotoCapture";
import { NoteComposer } from "./NoteComposer";
import { TodayStrip } from "./TodayStrip";

interface ProjectOption {
  id: string;
  name: string;
  client_name: string;
}

const STORAGE_KEY = "reslu-capture-project-id";

/**
 * /capture's interactive shell (BUILD-SPEC.md item 1a). Job picker
 * pinned at top (sticky), then — once a job is picked — the two huge
 * actions (photo, note/voice) and a "today" strip of everything
 * captured against this job so far today (Adelaide). Mobile-first:
 * single column, huge tap targets, sharp corners, brand cream/
 * off-white/charcoal/sand, real logo (rendered by the parent page,
 * not this component).
 */
export function CaptureWorkspace({ projects }: { projects: ProjectOption[] }) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const [captures, setCaptures] = useState<SiteCaptureWithUrl[]>([]);
  const [loadingCaptures, setLoadingCaptures] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore the last-used job from localStorage — a team member
  // reopening the homescreen icon partway through the same job
  // shouldn't have to re-pick it from the list every single time.
  // Purely a convenience default; the picker above is always available
  // to switch jobs.
  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    if (saved && projects.some((p) => p.id === saved)) {
      setProjectId(saved);
    }
  }, [projects]);

  useEffect(() => {
    if (projectId && typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, projectId);
    }
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId) {
      setCaptures([]);
      return;
    }
    setLoadingCaptures(true);
    setError(null);
    fetch(`/api/projects/${projectId}/site-captures`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Could not load captures.");
        return res.json();
      })
      .then((body) => {
        if (!cancelled) setCaptures(body.captures ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load captures.");
      })
      .finally(() => {
        if (!cancelled) setLoadingCaptures(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function onCaptured(capture: SiteCaptureWithUrl) {
    setCaptures((prev) => [capture, ...prev]);
  }

  const todayKey = useMemo(() => adelaideDateKey(new Date().toISOString()), []);
  const todayCaptures = useMemo(
    () => captures.filter((c) => adelaideDateKey(c.created_at) === todayKey),
    [captures, todayKey]
  );

  const selectedProject = projects.find((p) => p.id === projectId) ?? null;

  return (
    <div className="space-y-6 pb-16">
      <div className="sticky top-0 z-10 -mx-4 border-b border-[#dcd6cc] bg-cream px-4 pb-3 pt-1">
        <p className="label-caps mb-2 text-sand">Job</p>
        {projects.length === 0 ? (
          <p className="text-body text-charcoal/50">No active projects.</p>
        ) : (
          <div className="max-h-40 space-y-1.5 overflow-y-auto">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className={clsx(
                  "block w-full border px-4 py-3 text-left text-subhead transition-colors",
                  p.id === projectId
                    ? "border-nearblack bg-nearblack text-white"
                    : "border-[#c9c2b4] bg-offwhite text-nearblack hover:border-nearblack"
                )}
              >
                {p.name}
                <span className={clsx("ml-2 text-caption", p.id === projectId ? "text-white/60" : "text-charcoal/50")}>
                  {p.client_name}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>}

      {selectedProject ? (
        <>
          <PhotoCapture projectId={selectedProject.id} onCaptured={onCaptured} />
          <NoteComposer projectId={selectedProject.id} onCaptured={onCaptured} />
          <TodayStrip captures={todayCaptures} loading={loadingCaptures} />
        </>
      ) : (
        <p className="text-body text-charcoal/50">Pick a job above to start capturing.</p>
      )}
    </div>
  );
}
