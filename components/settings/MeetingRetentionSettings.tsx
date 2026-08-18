"use client";

import { useCallback, useEffect, useState } from "react";
import { boundedFetch } from "@/lib/bounded-request";
import {
  DEFAULT_MEETING_RECORDING_RETENTION_DAYS,
  DEFAULT_MEETING_TRANSCRIPT_RETENTION_DAYS,
  MEETING_RETENTION_ENABLE_CONFIRMATION,
  type MeetingSourceRetentionDueCounts,
  type MeetingSourceRetentionPolicy,
  type MeetingSourceRetentionAction,
} from "@/lib/meeting-retention";

const SETTINGS_REQUEST_TIMEOUT_MS = 15000;

interface RetentionResponse {
  policy?: MeetingSourceRetentionPolicy;
  due?: MeetingSourceRetentionDueCounts | null;
  can_edit?: boolean;
  error?: string;
}

export function MeetingRetentionSettings({ canEdit }: { canEdit: boolean }) {
  const [policy, setPolicy] = useState<MeetingSourceRetentionPolicy | null>(null);
  const [recordingDays, setRecordingDays] = useState(DEFAULT_MEETING_RECORDING_RETENTION_DAYS);
  const [transcriptDays, setTranscriptDays] = useState(DEFAULT_MEETING_TRANSCRIPT_RETENTION_DAYS);
  const [due, setDue] = useState<MeetingSourceRetentionDueCounts | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const applyResponse = useCallback((body: RetentionResponse) => {
    if (!body.policy) throw new Error(body.error ?? "Meeting retention policy is unavailable");
    setPolicy(body.policy);
    setRecordingDays(body.policy.recording_days);
    setTranscriptDays(body.policy.transcript_days);
    setDue(body.due ?? null);
  }, []);

  useEffect(() => {
    let active = true;
    void boundedFetch("/api/settings/meeting-retention", {}, SETTINGS_REQUEST_TIMEOUT_MS)
      .then(async (response) => {
        const body = await response.json() as RetentionResponse;
        if (!response.ok) throw new Error(body.error ?? "Meeting retention policy is unavailable");
        if (active) applyResponse(body);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "Meeting retention policy is unavailable");
      });
    return () => { active = false; };
  }, [applyResponse]);

  async function updatePolicy(action: MeetingSourceRetentionAction) {
    if (!canEdit || busy) return;
    if (!Number.isInteger(recordingDays) || recordingDays < 1 || recordingDays > 365) {
      setError("Raw audio retention must be a whole number from 1 to 365 days.");
      return;
    }
    if (!Number.isInteger(transcriptDays) || transcriptDays < recordingDays || transcriptDays > 3650) {
      setError("Transcript retention must be a whole number, at least as long as raw audio and no more than 3650 days.");
      return;
    }
    if (action === "enable") {
      const dueCopy = due && (due.recordings > 0 || due.transcripts > 0)
        ? ` ${due.recordings} recording(s) and ${due.transcripts} transcript(s) are already past their displayed dates and will become eligible on the next daily run.`
        : " No retained source is currently past its displayed deletion date.";
      if (!window.confirm(
        `Enable irreversible automatic deletion? Raw meeting audio will be deleted after ${recordingDays} days and source transcripts after ${transcriptDays} days.${dueCopy} Filed summaries, decisions and actions remain.`,
      )) return;
    } else if (action === "save" && policy?.enabled) {
      if (!window.confirm("Saving different retention periods turns automatic deletion off until the revised policy is explicitly approved again. Continue?")) return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await boundedFetch("/api/settings/meeting-retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recording_days: recordingDays,
          transcript_days: transcriptDays,
          action,
          ...(action === "enable" ? { confirmation: MEETING_RETENTION_ENABLE_CONFIRMATION } : {}),
        }),
      }, SETTINGS_REQUEST_TIMEOUT_MS);
      const body = await response.json() as RetentionResponse;
      if (!response.ok) throw new Error(body.error ?? "Meeting retention policy could not be saved");
      applyResponse(body);
      setNotice(action === "enable"
        ? "Automatic source deletion is enabled and audited."
        : action === "disable"
          ? "Automatic source deletion is off. Existing source remains available."
          : "Proposed retention periods saved. Automatic deletion remains off until approved.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Meeting retention policy could not be saved");
    } finally {
      setBusy(false);
    }
  }

  if (!policy && !error) {
    return <p className="text-body text-charcoal/60" role="status">Loading meeting retention policy…</p>;
  }

  return (
    <div className="max-w-3xl space-y-4 rounded-xl border border-[#d4cbbd] bg-white/55 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-body font-semibold text-nearblack">Automatic source deletion</p>
          <p className="mt-1 text-caption leading-relaxed text-charcoal/60">
            Raw audio and source transcripts are temporary working material. Filed meeting summaries, decisions, actions and links remain canonical and are never removed by this policy.
          </p>
        </div>
        <span className={`rounded-full px-3 py-1 text-caption font-semibold ${policy?.enabled ? "bg-green-100 text-green-900" : "bg-[#ece7dd] text-charcoal"}`}>
          {policy?.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700" role="alert">{error}</p>}
      {notice && <p className="border border-green-700/30 bg-green-50 px-3 py-2 text-caption text-green-900" role="status" aria-live="polite">{notice}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-caps mb-1 block">Delete raw audio after</span>
          <span className="flex items-center gap-2">
            <input type="number" min="1" max="365" step="1" value={recordingDays} onChange={(event) => setRecordingDays(Number(event.target.value))} disabled={!canEdit || busy} className="min-h-11 w-28 border border-[#c9c2b4] bg-nearwhite px-3 text-body focus:border-nearblack focus:outline-none disabled:opacity-60" />
            <span className="text-body text-charcoal/70">days</span>
          </span>
        </label>
        <label className="block">
          <span className="label-caps mb-1 block">Delete source transcript after</span>
          <span className="flex items-center gap-2">
            <input type="number" min="1" max="3650" step="1" value={transcriptDays} onChange={(event) => setTranscriptDays(Number(event.target.value))} disabled={!canEdit || busy} className="min-h-11 w-28 border border-[#c9c2b4] bg-nearwhite px-3 text-body focus:border-nearblack focus:outline-none disabled:opacity-60" />
            <span className="text-body text-charcoal/70">days</span>
          </span>
        </label>
      </div>

      {canEdit && due && (
        <p className="text-caption leading-relaxed text-charcoal/65">
          Eligible at the next daily run if enabled: <strong>{due.recordings}</strong> recording(s) and <strong>{due.transcripts}</strong> transcript(s).
        </p>
      )}

      {canEdit ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => void updatePolicy("save")} disabled={busy} className="min-h-11 border border-[#b8ad9d] px-4 py-2 text-caption font-semibold text-nearblack hover:bg-[#f3eee5] disabled:opacity-40">
            Save proposed periods
          </button>
          {policy?.enabled ? (
            <button type="button" onClick={() => void updatePolicy("disable")} disabled={busy} className="min-h-11 border border-red-700 px-4 py-2 text-caption font-semibold text-red-800 hover:bg-red-50 disabled:opacity-40">
              Turn automatic deletion off
            </button>
          ) : (
            <button type="button" onClick={() => void updatePolicy("enable")} disabled={busy} className="min-h-11 bg-nearblack px-4 py-2 text-caption font-semibold text-white hover:bg-charcoal disabled:opacity-40">
              Approve &amp; enable
            </button>
          )}
        </div>
      ) : (
        <p className="text-caption text-charcoal/55">Only an admin can approve or change this studio-wide policy.</p>
      )}

      {policy?.approved_at && (
        <p className="text-caption text-charcoal/50">Approved {new Date(policy.approved_at).toLocaleString("en-AU")}.</p>
      )}
    </div>
  );
}
