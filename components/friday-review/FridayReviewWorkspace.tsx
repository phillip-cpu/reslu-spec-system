"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { FridayReview, FridayReviewProject } from "@/types/friday-review";

function longDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export function FridayReviewWorkspace() {
  const [review, setReview] = useState<FridayReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/friday-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not start Friday Review.");
        return body.review as FridayReview;
      })
      .then(setReview)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not start Friday Review."))
      .finally(() => setLoading(false));
  }, []);

  const completeCount = review?.projects.filter((entry) => entry.review_status === "complete").length ?? 0;
  const totalCount = review?.projects.length ?? 0;
  const allComplete = totalCount > 0 && completeCount === totalCount;

  function patchLocal(entryId: string, patch: Partial<FridayReviewProject>) {
    setReview((current) =>
      current
        ? {
            ...current,
            projects: current.projects.map((entry) =>
              entry.id === entryId
                ? {
                    ...entry,
                    ...patch,
                    review_status:
                      entry.review_status === "not_started" &&
                      Object.keys(patch).some((key) => !["review_status", "no_update"].includes(key))
                        ? "in_progress"
                        : patch.review_status ?? entry.review_status,
                  }
                : entry
            ),
          }
        : current
    );
  }

  async function saveEntry(entry: FridayReviewProject, status?: FridayReviewProject["review_status"]) {
    if (!review || review.status === "completed") return;
    if ((status ?? entry.review_status) === "complete" && entry.client_worthy && !entry.client_update.trim()) {
      setError(`${entry.project.name}: add the client-facing facts or turn off “Prepare a client diary update”.`);
      return;
    }
    setSavingId(entry.id);
    setError(null);
    try {
      const response = await fetch("/api/friday-review", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entry_id: entry.id,
          review_status: status ?? entry.review_status,
          this_week: entry.this_week,
          next_week: entry.next_week,
          blockers: entry.blockers,
          client_update: entry.client_update,
          action_items: entry.action_items,
          client_worthy: entry.client_worthy,
          no_update: entry.no_update,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save project review.");
      setReview(body.review as FridayReview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save project review.");
    } finally {
      setSavingId(null);
    }
  }

  async function finishReview() {
    if (!review || !allComplete || review.status === "completed") return;
    if (!confirm("Finish this Friday Review, create the listed Office tasks and send client updates to Aria?")) return;
    setFinishing(true);
    setError(null);
    try {
      const response = await fetch("/api/friday-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "complete", review_id: review.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not finish Friday Review.");
      setReview(body.review as FridayReview);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not finish Friday Review.");
    } finally {
      setFinishing(false);
    }
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Preparing this week&apos;s projects…</p>;
  }
  if (!review) {
    return <p className="border border-red-700/40 bg-red-50 p-4 text-body text-red-700">{error}</p>;
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      {error && <p className="border border-red-700/40 bg-red-50 p-3 text-body text-red-700">{error}</p>}

      <section className="border border-[#c9c2b4] bg-offwhite p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="label-caps text-sand">Week ending</p>
            <h2 className="mt-1 font-display text-[28px] text-nearblack">{longDate(review.week_ending)}</h2>
            <p className="mt-1 text-body text-charcoal/60">
              {review.status === "completed"
                ? "Meeting complete. Tasks and client-diary drafts have been handed off."
                : `${completeCount} of ${totalCount} active projects reviewed`}
            </p>
          </div>
          <div className="min-w-[260px]">
            <div className="mb-2 flex justify-between text-caption text-charcoal/55">
              <span>Meeting progress</span>
              <span>{totalCount ? Math.round((completeCount / totalCount) * 100) : 0}%</span>
            </div>
            <div className="h-2 border border-[#c9c2b4] bg-cream">
              <div
                className="h-full bg-[#4c6b4f] transition-[width]"
                style={{ width: `${totalCount ? (completeCount / totalCount) * 100 : 0}%` }}
              />
            </div>
          </div>
        </div>
      </section>

      <div className="space-y-4">
        {review.projects.map((entry, index) => (
          <ProjectReviewCard
            key={entry.id}
            entry={entry}
            number={index + 1}
            disabled={review.status === "completed"}
            saving={savingId === entry.id}
            onChange={(patch) => patchLocal(entry.id, patch)}
            onSave={(status) => saveEntry(entry, status)}
          />
        ))}
      </div>

      <div className="sticky bottom-0 flex flex-col gap-3 border border-[#c9c2b4] bg-cream/95 p-4 shadow-[0_-8px_24px_rgba(25,24,22,0.08)] backdrop-blur sm:flex-row sm:items-center sm:justify-between">
        <p className="text-body text-charcoal/60">
          {review.status === "completed"
            ? "Friday Review complete."
            : allComplete
              ? "Every active project has been reviewed."
              : `${totalCount - completeCount} project${totalCount - completeCount === 1 ? "" : "s"} still to review.`}
        </p>
        <button
          type="button"
          disabled={!allComplete || review.status === "completed" || finishing}
          onClick={finishReview}
          className="bg-nearblack px-5 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-35"
        >
          {review.status === "completed" ? "Meeting complete" : finishing ? "Finishing…" : "Finish Friday Review"}
        </button>
      </div>
    </div>
  );
}

function ProjectReviewCard({
  entry,
  number,
  disabled,
  saving,
  onChange,
  onSave,
}: {
  entry: FridayReviewProject;
  number: number;
  disabled: boolean;
  saving: boolean;
  onChange: (patch: Partial<FridayReviewProject>) => void;
  onSave: (status?: FridayReviewProject["review_status"]) => void;
}) {
  const [open, setOpen] = useState(entry.review_status !== "complete");
  const actionText = useMemo(() => entry.action_items.join("\n"), [entry.action_items]);
  const stateLabel =
    entry.review_status === "complete" ? "Reviewed" : entry.review_status === "in_progress" ? "In progress" : "Not started";
  const diaryLabel =
    entry.diary_status === "pending_approval"
      ? "Aria draft ready for review"
      : entry.diary_status === "published"
        ? "Published"
        : entry.aria_queue_id
          ? "Queued with Aria"
          : null;

  return (
    <section className={clsx("border bg-offwhite", entry.review_status === "complete" ? "border-[#8ca08e]" : "border-[#d5cfc4]")}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-3 p-4 text-left sm:p-5"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#c9c2b4] text-caption text-charcoal/55">
          {number}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[23px] text-nearblack">{entry.project.name}</span>
          <span className="block truncate text-caption text-charcoal/50">
            {entry.project.client_name}
            {entry.project.address ? ` · ${entry.project.address}` : ""}
          </span>
        </span>
        <span
          className={clsx(
            "label-caps border px-2 py-1",
            entry.review_status === "complete"
              ? "border-[#4c6b4f] bg-[#edf3ed] text-[#4c6b4f]"
              : entry.review_status === "in_progress"
                ? "border-sand text-sand"
                : "border-[#c9c2b4] text-charcoal/45"
          )}
        >
          {stateLabel}
        </span>
        <span className="text-charcoal/45">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="border-t border-[#e1dcd2] p-4 sm:p-5">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <Link href={`/projects/${entry.project_id}`} className="text-caption text-charcoal/55 underline hover:text-nearblack">
              Open project overview ↗
            </Link>
            <label className="flex items-center gap-2 text-caption text-charcoal/65">
              <input
                type="checkbox"
                checked={entry.no_update}
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    no_update: event.target.checked,
                    review_status: "in_progress",
                  })
                }
              />
              No project update this week
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Field
              label="What happened this week"
              value={entry.this_week}
              disabled={disabled || entry.no_update}
              placeholder="Work completed, site progress, decisions made…"
              onChange={(value) => onChange({ this_week: value })}
              onBlur={() => onSave()}
            />
            <Field
              label="Next week"
              value={entry.next_week}
              disabled={disabled || entry.no_update}
              placeholder="Planned trades, orders, meetings and milestones…"
              onChange={(value) => onChange({ next_week: value })}
              onBlur={() => onSave()}
            />
            <Field
              label="Problems, delays or decisions"
              value={entry.blockers}
              disabled={disabled || entry.no_update}
              placeholder="Anything the team needs to resolve…"
              onChange={(value) => onChange({ blockers: value })}
              onBlur={() => onSave()}
            />
            <Field
              label="Actions — one task per line"
              value={actionText}
              disabled={disabled || entry.no_update}
              placeholder={"Confirm plumber booking\nOrder replacement tile"}
              onChange={(value) => onChange({ action_items: value.split(/\r?\n/) })}
              onBlur={() => onSave()}
            />
          </div>

          <div className="mt-4 border border-sand/50 bg-cream p-4">
            <label className="mb-3 flex items-center gap-2 text-subhead text-nearblack">
              <input
                type="checkbox"
                checked={entry.client_worthy}
                disabled={disabled || entry.no_update}
                onChange={(event) => onChange({ client_worthy: event.target.checked })}
              />
              Prepare a client diary update
            </label>
            <Field
              label="Client-facing facts for Aria"
              value={entry.client_update}
              disabled={disabled || entry.no_update || !entry.client_worthy}
              placeholder="Write the facts plainly. Aria will turn them into a warm, polished update for your approval."
              onChange={(value) => onChange({ client_update: value })}
              onBlur={() => onSave()}
              rows={3}
            />
            {diaryLabel && <p className="mt-2 text-caption text-[#4c6b4f]">{diaryLabel}</p>}
          </div>

          {!disabled && (
            <div className="mt-4 flex justify-end gap-2">
              {entry.review_status === "complete" ? (
                <button
                  type="button"
                  onClick={() => onSave("in_progress")}
                  className="border border-[#c9c2b4] px-4 py-2 text-caption text-charcoal/65 hover:border-nearblack"
                >
                  Reopen
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onSave("complete")}
                  disabled={saving}
                  className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-40"
                >
                  {saving ? "Saving…" : "Mark project reviewed"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Field({
  label,
  value,
  disabled,
  placeholder,
  onChange,
  onBlur,
  rows = 4,
}: {
  label: string;
  value: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="label-caps mb-1.5 block text-charcoal/55">{label}</span>
      <textarea
        value={value}
        rows={rows}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        className="w-full resize-y border border-[#c9c2b4] bg-cream px-3 py-2 text-body text-nearblack outline-none focus:border-nearblack disabled:bg-[#eeeae2] disabled:text-charcoal/45"
      />
    </label>
  );
}
