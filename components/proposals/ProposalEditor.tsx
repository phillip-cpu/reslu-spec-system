"use client";

import { useCallback, useEffect, useState, type FocusEvent } from "react";
import clsx from "clsx";
import type {
  Proposal,
  ProposalContent,
  ProposalFeeStage,
  ProposalScopeSection,
  ProposalStatus,
  ProposalTimelineRow,
} from "@/types/proposals";

/**
 * Deliberately NOT importing lib/proposals.ts's own sumStageMilestones()
 * here (even though it's the exact same one-line sum) — that module
 * imports lib/client-invoices.ts's roundHalfUpCents(), which itself
 * imports lib/report-error.ts, which imports lib/supabase/server.ts's
 * createServiceRoleClient() — a chain that ends at next/headers, a
 * genuinely server-only API. This file is "use client"; pulling that
 * whole chain into the browser bundle would break the build (Next.js
 * hard-errors on next/headers inside client code), not just bloat it.
 * A three-line duplicate, same "small deliberate duplication between
 * independent pipelines" precedent lib/proposal-emails.ts's own header
 * comment documents — see that file for the fuller version of this
 * exact reasoning.
 */
function sumStageMilestones(stage: { milestones: { amount_inc: number }[] }): number {
  const raw = stage.milestones.reduce((sum, m) => sum + (Number(m.amount_inc) || 0), 0);
  return Math.round(raw * 100) / 100;
}

const STATUS_STYLES: Record<ProposalStatus, string> = {
  draft: "border-[#c9c2b4] text-charcoal/60",
  sent: "border-sand text-sand",
  accepted: "border-nearblack bg-nearblack text-white",
  closed: "border-red-700/40 text-red-700",
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = arr.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

const inputClass =
  "w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none";
const labelClass = "label-caps mb-1 block !text-charcoal/50";
const smallBtn = "border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal/70 hover:border-nearblack";

/**
 * The Builder UI's proposal editor — BUILD-SPEC.md §"Fee proposal
 * phase (r23)" item 3: "section editor per spec item 3 (letter
 * textarea, vision textarea, scope sections add/remove/reorder with
 * bullets + deliverables line editors, fees: staged|single mode,
 * stages with milestone rows, amounts inc GST, auto-sum stage totals +
 * grand total_inc, deposit_inc field ..., timeline rows, exclusions
 * bullets + allowance text, terms_md textarea prefilled)."
 *
 * DRAFT-COMMIT-ON-BLUR, not per-keystroke PATCH — mirrors
 * components/leads/LeadDetailPanel.tsx's own single-save pattern
 * (`draft` state mirrors the record, edits mark `dirty`, one PATCH
 * commits on blur-away-from-panel) rather than SowBuilder's per-ROW
 * save, since a proposal's whole content is ONE jsonb blob with no
 * sub-row ids to PATCH independently (see migration 051's own table
 * comment) — the panel-blur-commits-everything shape is the right fit
 * here, not SowBuilder's per-line PATCH shape. `handleBlur` below is
 * the exact same `e.currentTarget.contains(e.relatedTarget)` technique
 * LeadDetailPanel's `handlePanelBlur` uses: focus moving to another
 * field INSIDE this editor doesn't commit; focus leaving the whole
 * editor does.
 */
export function ProposalEditor({ proposalId }: { proposalId: string }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [content, setContent] = useState<ProposalContent | null>(null);
  const [depositInc, setDepositInc] = useState<number>(0);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load this proposal.");
      const p: Proposal = body.proposal;
      setProposal(p);
      setContent(p.content);
      setDepositInc(p.deposit_inc);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this proposal.");
    } finally {
      setLoading(false);
    }
  }, [proposalId]);

  useEffect(() => {
    load();
  }, [load]);

  function patchContent(next: ProposalContent) {
    setContent(next);
    setDirty(true);
  }

  async function save() {
    if (!dirty || saving || !content) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, deposit_inc: depositInc }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not save this proposal.");
      setProposal(body.proposal);
      setContent(body.proposal.content);
      setDepositInc(body.proposal.deposit_inc);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this proposal.");
    } finally {
      setSaving(false);
    }
  }

  function handleBlur(e: FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    save();
  }

  async function send() {
    setSending(true);
    setSendResult(null);
    setError(null);
    try {
      if (dirty) await save();
      const res = await fetch(`/api/proposals/${proposalId}/send`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not send this proposal.");
      setProposal(body.proposal);
      setSendResult(
        body.email?.action === "sent"
          ? "Sent."
          : body.email?.action === "queued"
            ? "Queued (outside the 7am-7pm Adelaide send window)."
            : `Not sent: ${body.email?.reason ?? "unknown reason"}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send this proposal.");
    } finally {
      setSending(false);
    }
  }

  async function resend() {
    setSending(true);
    setSendResult(null);
    setError(null);
    try {
      const res = await fetch(`/api/proposals/${proposalId}/resend`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not resend this proposal.");
      setSendResult(
        body.email?.action === "sent"
          ? "Resent."
          : body.email?.action === "queued"
            ? "Queued (outside the 7am-7pm Adelaide send window)."
            : `Not sent: ${body.email?.reason ?? "unknown reason"}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend this proposal.");
    } finally {
      setSending(false);
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading proposal…</p>;
  if (!proposal || !content) {
    return <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error ?? "Proposal not found."}</p>;
  }

  const readOnly = proposal.status === "accepted" || proposal.status === "closed";
  const grandTotal = content.fees.stages.reduce((s, st) => s + (Number(st.total_inc) || 0), 0);
  const previewUrl = `/proposal/${proposal.token}`;

  return (
    <div className="space-y-8" onBlur={handleBlur}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#dcd6cc] pb-4">
        <div className="flex items-center gap-3">
          <span className={clsx("border px-2 py-0.5 text-caption uppercase", STATUS_STYLES[proposal.status])}>
            {proposal.status}
          </span>
          {dirty && <span className="text-caption text-sand">Unsaved changes — saves on blur</span>}
          {saving && <span className="text-caption text-charcoal/40">Saving…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a href={previewUrl} target="_blank" rel="noopener noreferrer" className={smallBtn}>
            Live preview →
          </a>
          {proposal.status === "draft" && (
            <button type="button" onClick={send} disabled={sending} className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-50">
              {sending ? "Sending…" : "Send"}
            </button>
          )}
          {proposal.status === "sent" && (
            <button type="button" onClick={resend} disabled={sending} className="border border-sand px-4 py-2 text-caption text-sand hover:bg-sand hover:text-white disabled:opacity-50">
              {sending ? "Resending…" : "Resend"}
            </button>
          )}
        </div>
      </div>

      {error && <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>}
      {sendResult && <p className="border border-sand/50 bg-offwhite px-4 py-2 text-body text-charcoal/70">{sendResult}</p>}

      {readOnly && (
        <p className="border border-[#dcd6cc] bg-offwhite px-4 py-2 text-body text-charcoal/60">
          This proposal is {proposal.status} and can no longer be edited.
        </p>
      )}

      <fieldset disabled={readOnly} className="space-y-8">
        {/* Letter */}
        <section>
          <label className={labelClass}>Letter</label>
          <textarea
            value={content.letter}
            onChange={(e) => patchContent({ ...content, letter: e.target.value })}
            rows={8}
            className={inputClass}
          />
        </section>

        {/* Vision */}
        <section>
          <label className={labelClass}>Project Vision Alignment</label>
          <textarea
            value={content.vision}
            onChange={(e) => patchContent({ ...content, vision: e.target.value })}
            rows={6}
            className={inputClass}
          />
        </section>

        {/* Scope sections */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p className="label-caps !text-charcoal/50">Scope of Design Services</p>
            <button
              type="button"
              className={smallBtn}
              onClick={() =>
                patchContent({
                  ...content,
                  scope_sections: [...content.scope_sections, { title: "New section", bullets: [], deliverables: [] }],
                })
              }
            >
              + Add section
            </button>
          </div>
          <div className="space-y-4">
            {content.scope_sections.map((section, si) => (
              <ScopeSectionEditor
                key={si}
                section={section}
                onChange={(next) =>
                  patchContent({
                    ...content,
                    scope_sections: content.scope_sections.map((s, i) => (i === si ? next : s)),
                  })
                }
                onRemove={() => patchContent({ ...content, scope_sections: content.scope_sections.filter((_, i) => i !== si) })}
                onMove={(dir) =>
                  patchContent({ ...content, scope_sections: move(content.scope_sections, si, si + dir) })
                }
              />
            ))}
          </div>
        </section>

        {/* Fees */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p className="label-caps !text-charcoal/50">Design Fee</p>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-caption text-charcoal/70">
                <input
                  type="radio"
                  checked={content.fees.mode === "staged"}
                  onChange={() => patchContent({ ...content, fees: { ...content.fees, mode: "staged" } })}
                />
                Staged
              </label>
              <label className="flex items-center gap-1.5 text-caption text-charcoal/70">
                <input
                  type="radio"
                  checked={content.fees.mode === "single"}
                  onChange={() => patchContent({ ...content, fees: { ...content.fees, mode: "single" } })}
                />
                Single
              </label>
              <button
                type="button"
                className={smallBtn}
                onClick={() =>
                  patchContent({
                    ...content,
                    fees: {
                      ...content.fees,
                      stages: [...content.fees.stages, { label: "New stage", total_inc: 0, milestones: [] }],
                    },
                  })
                }
              >
                + Add stage
              </button>
            </div>
          </div>
          <div className="space-y-4">
            {content.fees.stages.map((stage, sti) => (
              <FeeStageEditor
                key={sti}
                stage={stage}
                onChange={(next) =>
                  patchContent({
                    ...content,
                    fees: { ...content.fees, stages: content.fees.stages.map((s, i) => (i === sti ? next : s)) },
                  })
                }
                onRemove={() =>
                  patchContent({ ...content, fees: { ...content.fees, stages: content.fees.stages.filter((_, i) => i !== sti) } })
                }
              />
            ))}
          </div>

          <div className="mt-4">
            <label className={labelClass}>Payment structure lines (free text — % or narrative)</label>
            <LineListEditor
              lines={content.fees.payment_lines}
              onChange={(lines) => patchContent({ ...content, fees: { ...content.fees, payment_lines: lines } })}
              placeholder="e.g. 30% deposit on acceptance"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#dcd6cc] pt-3">
            <p className="text-subhead text-nearblack">Total design fee (inc GST): {formatMoney(grandTotal)}</p>
            <label className="flex items-center gap-2">
              <span className={labelClass}>Deposit (inc GST)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={depositInc}
                onChange={(e) => {
                  setDepositInc(Number(e.target.value) || 0);
                  setDirty(true);
                }}
                className={clsx(inputClass, "w-32")}
              />
            </label>
          </div>
        </section>

        {/* Timeline */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <p className="label-caps !text-charcoal/50">Project Timeline</p>
            <button
              type="button"
              className={smallBtn}
              onClick={() => patchContent({ ...content, timeline: [...content.timeline, { phase: "", duration: "" }] })}
            >
              + Add row
            </button>
          </div>
          <div className="space-y-2">
            {content.timeline.map((row, ti) => (
              <TimelineRowEditor
                key={ti}
                row={row}
                onChange={(next) => patchContent({ ...content, timeline: content.timeline.map((r, i) => (i === ti ? next : r)) })}
                onRemove={() => patchContent({ ...content, timeline: content.timeline.filter((_, i) => i !== ti) })}
              />
            ))}
          </div>
          <p className="mt-2 text-caption italic text-charcoal/40">
            Council assessment timeframes are subject to authority processing and are outside of our control. (shown automatically on the client page &amp; PDF)
          </p>
        </section>

        {/* Exclusions */}
        <section>
          <label className={labelClass}>Exclusions</label>
          <LineListEditor
            lines={content.exclusions.bullets}
            onChange={(bullets) => patchContent({ ...content, exclusions: { ...content.exclusions, bullets } })}
            placeholder="e.g. Structural engineering."
          />
          <label className={clsx(labelClass, "mt-3")}>Consultant allowance note</label>
          <textarea
            value={content.exclusions.allowance}
            onChange={(e) => patchContent({ ...content, exclusions: { ...content.exclusions, allowance: e.target.value } })}
            rows={3}
            className={inputClass}
          />
        </section>

        {/* Terms */}
        <section>
          <label className={labelClass}>Terms</label>
          <textarea
            value={content.terms_md}
            onChange={(e) => patchContent({ ...content, terms_md: e.target.value })}
            rows={16}
            className={clsx(inputClass, "font-mono text-caption")}
          />
        </section>
      </fieldset>
    </div>
  );
}

function ScopeSectionEditor({
  section,
  onChange,
  onRemove,
  onMove,
}: {
  section: ProposalScopeSection;
  onChange: (next: ProposalScopeSection) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="border border-[#dcd6cc] p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={section.title}
          onChange={(e) => onChange({ ...section, title: e.target.value })}
          className={clsx(inputClass, "flex-1")}
          placeholder="Section title"
        />
        <button type="button" className={smallBtn} onClick={() => onMove(-1)}>
          ↑
        </button>
        <button type="button" className={smallBtn} onClick={() => onMove(1)}>
          ↓
        </button>
        <button type="button" className={clsx(smallBtn, "text-red-700/70")} onClick={onRemove}>
          Remove
        </button>
      </div>
      <input
        value={section.intro ?? ""}
        onChange={(e) => onChange({ ...section, intro: e.target.value || undefined })}
        className={clsx(inputClass, "mb-2")}
        placeholder="Optional intro paragraph"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <p className={labelClass}>Bullets</p>
          <LineListEditor lines={section.bullets} onChange={(bullets) => onChange({ ...section, bullets })} placeholder="Bullet line" />
        </div>
        <div>
          <p className={labelClass}>Deliverables (→)</p>
          <LineListEditor
            lines={section.deliverables}
            onChange={(deliverables) => onChange({ ...section, deliverables })}
            placeholder="Deliverable line"
          />
        </div>
      </div>
    </div>
  );
}

function FeeStageEditor({
  stage,
  onChange,
  onRemove,
}: {
  stage: ProposalFeeStage;
  onChange: (next: ProposalFeeStage) => void;
  onRemove: () => void;
}) {
  const summed = sumStageMilestones(stage);
  return (
    <div className="border border-[#dcd6cc] p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={stage.label}
          onChange={(e) => onChange({ ...stage, label: e.target.value })}
          className={clsx(inputClass, "flex-1")}
          placeholder="Stage label"
        />
        <label className="flex items-center gap-1.5">
          <span className="text-caption text-charcoal/50">Total (inc GST)</span>
          <input
            type="number"
            min={0}
            step="0.01"
            value={stage.total_inc}
            onChange={(e) => onChange({ ...stage, total_inc: Number(e.target.value) || 0 })}
            className={clsx(inputClass, "w-28")}
          />
        </label>
        <button
          type="button"
          className={smallBtn}
          title="Set the stage total to the sum of its milestones"
          onClick={() => onChange({ ...stage, total_inc: summed })}
        >
          = {formatMoney(summed)}
        </button>
        <button type="button" className={clsx(smallBtn, "text-red-700/70")} onClick={onRemove}>
          Remove
        </button>
      </div>
      <div className="space-y-1.5">
        {stage.milestones.map((m, mi) => (
          <div key={mi} className="flex items-center gap-2">
            <input
              value={m.label}
              onChange={(e) =>
                onChange({
                  ...stage,
                  milestones: stage.milestones.map((mm, i) => (i === mi ? { ...mm, label: e.target.value } : mm)),
                })
              }
              className={clsx(inputClass, "flex-1")}
              placeholder="Milestone label"
            />
            <input
              type="number"
              min={0}
              step="0.01"
              value={m.amount_inc}
              onChange={(e) =>
                onChange({
                  ...stage,
                  milestones: stage.milestones.map((mm, i) =>
                    i === mi ? { ...mm, amount_inc: Number(e.target.value) || 0 } : mm
                  ),
                })
              }
              className={clsx(inputClass, "w-28")}
            />
            <button
              type="button"
              className={clsx(smallBtn, "text-red-700/70")}
              onClick={() => onChange({ ...stage, milestones: stage.milestones.filter((_, i) => i !== mi) })}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className={smallBtn}
          onClick={() => onChange({ ...stage, milestones: [...stage.milestones, { label: "", amount_inc: 0 }] })}
        >
          + Add milestone
        </button>
      </div>
    </div>
  );
}

function TimelineRowEditor({
  row,
  onChange,
  onRemove,
}: {
  row: ProposalTimelineRow;
  onChange: (next: ProposalTimelineRow) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        value={row.phase}
        onChange={(e) => onChange({ ...row, phase: e.target.value })}
        className={clsx(inputClass, "flex-1")}
        placeholder="Phase"
      />
      <input
        value={row.duration}
        onChange={(e) => onChange({ ...row, duration: e.target.value })}
        className={clsx(inputClass, "w-48")}
        placeholder="Duration, e.g. 6 to 8 weeks"
      />
      <button type="button" className={clsx(smallBtn, "text-red-700/70")} onClick={onRemove}>
        ✕
      </button>
    </div>
  );
}

function LineListEditor({
  lines,
  onChange,
  placeholder,
}: {
  lines: string[];
  onChange: (lines: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      {lines.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            value={line}
            onChange={(e) => onChange(lines.map((l, li) => (li === i ? e.target.value : l)))}
            className={inputClass}
            placeholder={placeholder}
          />
          <button type="button" className={clsx(smallBtn, "text-red-700/70")} onClick={() => onChange(lines.filter((_, li) => li !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className={smallBtn} onClick={() => onChange([...lines, ""])}>
        + Add line
      </button>
    </div>
  );
}
