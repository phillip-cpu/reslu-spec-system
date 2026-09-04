"use client";

import { useId, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { groupJobPlanThreads } from "@/lib/job-plan";
import type {
  JobPlanItemInput,
  JobPlanModel,
  JobPlanThread,
  JobPlanView,
} from "@/types/job-plan";

const VIEWS: { key: JobPlanView; label: string; adminOnly?: boolean }[] = [
  { key: "scope", label: "Room / Scope" },
  { key: "trade", label: "Trade" },
  { key: "cost", label: "Cost", adminOnly: true },
  { key: "procurement", label: "Procurement" },
  { key: "programme", label: "Programme" },
];

const money = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

function formatDate(value: string | null): string {
  if (!value) return "Date not set";
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", year: "numeric" }).format(
    new Date(`${value.slice(0, 10)}T00:00:00`)
  );
}

function routeFor(projectId: string, destination: "scope" | "estimate" | "ffe" | "board" | "timeline"): string {
  if (destination === "scope") return `/projects/${projectId}/sow`;
  if (destination === "estimate") return `/projects/${projectId}/estimate`;
  if (destination === "ffe") return `/projects/${projectId}?tab=ffe&view=procurement`;
  return `/projects/${projectId}/${destination}`;
}

function StatusDot({ good, label }: { good: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-caption text-charcoal/65">
      <span className={clsx("h-1.5 w-1.5 rounded-full", good ? "bg-[#557a60]" : "bg-[#bd8447]")} />
      {label}
    </span>
  );
}

function PriceInput({
  item,
  value,
  saving,
  error,
  onChange,
  onSave,
}: {
  item: JobPlanItemInput;
  value: number | null;
  saving: boolean;
  error: string | null;
  onChange: (value: number | null) => void;
  onSave: () => void;
}) {
  const inputId = useId();
  if (item.cost_scope === "trade_package") {
    return <span className="text-caption text-charcoal/55">Included in trade package — no second item cost</span>;
  }
  return (
    <div onDoubleClick={(event) => event.stopPropagation()}>
      <label className="label-caps block text-charcoal/55" htmlFor={inputId}>
        Trade cost ex GST
      </label>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-body text-charcoal/55">$</span>
        <input
          id={inputId}
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value ?? ""}
          placeholder="Enter price"
          onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
          onBlur={onSave}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="w-36 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body text-nearblack outline-none focus:border-nearblack"
        />
        <span className="text-caption text-charcoal/50">{saving ? "Saving…" : "per item"}</span>
      </div>
      {error && <p className="mt-1 text-caption text-red-700">{error}</p>}
    </div>
  );
}

function ThreadSummary({ thread }: { thread: JobPlanThread }) {
  const firstActivity = thread.activities[0];
  const directItems = thread.items.filter((item) => item.cost_scope === "direct").length;
  return (
    <div className="grid gap-3 px-4 py-4 md:grid-cols-[minmax(0,2.2fr)_minmax(120px,1fr)_minmax(120px,1fr)_minmax(120px,1fr)] md:px-5">
      <div className="min-w-0">
        <p className="text-body font-medium leading-6 text-nearblack">{thread.title}</p>
        <p className="mt-1 text-caption text-charcoal/50">
          {thread.scope_lines.length} scope clause{thread.scope_lines.length === 1 ? "" : "s"} · {thread.rooms.join(", ") || "No room"}
        </p>
      </div>
      <div>
        <p className="label-caps text-charcoal/45">Trade</p>
        <p className="mt-1 text-body text-nearblack">{thread.trade ?? "Not assigned"}</p>
        <p className="text-caption text-charcoal/50">{thread.contractor_company ?? "No contractor"}</p>
      </div>
      <div>
        <p className="label-caps text-charcoal/45">FF&amp;E / cost</p>
        <p className="mt-1 text-body text-nearblack">
          {thread.items.length ? `${thread.items.length} referenced` : "No item reference"}
        </p>
        <p className="text-caption text-charcoal/50">
          {directItems ? `${directItems} direct · ${thread.quotes.length} quote pack${thread.quotes.length === 1 ? "" : "s"}` : "Included / labour scope"}
        </p>
      </div>
      <div className="flex items-start justify-between gap-3 md:block">
        <div>
          <p className="label-caps text-charcoal/45">Programme</p>
          <p className="mt-1 text-body text-nearblack">{thread.phase_name ?? "Not planned"}</p>
          <p className="text-caption text-charcoal/50">{firstActivity?.booking_date ? formatDate(firstActivity.booking_date) : firstActivity?.status ?? "No activity"}</p>
        </div>
        <span className="mt-1 shrink-0 border border-[#c9c2b4] px-2 py-1 text-caption text-nearblack md:inline-block">
          Review
        </span>
      </div>
    </div>
  );
}

export function JobPlanWorkspace({
  projectId,
  initialModel,
  isAdmin,
}: {
  projectId: string;
  initialModel: JobPlanModel;
  isAdmin: boolean;
}) {
  const [view, setView] = useState<JobPlanView>("scope");
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
  const uniqueItems = useMemo(
    () => [...new Map(initialModel.threads.flatMap((thread) => thread.items).map((item) => [item.id, item])).values()],
    [initialModel.threads]
  );
  const [prices, setPrices] = useState<Record<string, number | null>>(
    () => Object.fromEntries(uniqueItems.map((item) => [item.id, item.price_trade]))
  );
  const [savedPrices, setSavedPrices] = useState<Record<string, number | null>>(
    () => Object.fromEntries(uniqueItems.map((item) => [item.id, item.price_trade]))
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [priceErrors, setPriceErrors] = useState<Record<string, string | null>>({});
  const groups = useMemo(() => groupJobPlanThreads(initialModel.threads, view), [initialModel.threads, view]);
  const directMissingPrice = uniqueItems.filter(
    (item) => item.cost_scope === "direct" && prices[item.id] === null
  ).length;

  async function savePrice(itemId: string) {
    const next = prices[itemId] ?? null;
    if (savedPrices[itemId] === next || savingId === itemId) return;
    setSavingId(itemId);
    setPriceErrors((current) => ({ ...current, [itemId]: null }));
    try {
      const response = await fetch(`/api/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ price_trade: next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.item || body.item.id !== itemId) {
        throw new Error(body.error ?? "Could not save price");
      }
      const confirmed = typeof body.item.price_trade === "number" ? body.item.price_trade : null;
      setPrices((current) => ({ ...current, [itemId]: confirmed }));
      setSavedPrices((current) => ({ ...current, [itemId]: confirmed }));
    } catch (error) {
      setPrices((current) => ({ ...current, [itemId]: savedPrices[itemId] ?? null }));
      setPriceErrors((current) => ({
        ...current,
        [itemId]: error instanceof Error ? error.message : "Could not save price",
      }));
    } finally {
      setSavingId(null);
    }
  }

  if (!initialModel.sow_id) {
    return (
      <section className="mx-auto max-w-3xl border border-[#dcd6cc] bg-offwhite p-8 text-center">
        <p className="label-caps">Connected job plan</p>
        <h2 className="mt-2 font-display text-section text-nearblack">Start with the Scope of Works</h2>
        <p className="mx-auto mt-3 max-w-xl text-body text-charcoal/65">
          The plan connects scope clauses to trades, FF&amp;E, pricing and the programme. Your ballpark Estimate can still be built before the scope is finished.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href={`/projects/${projectId}/sow`} className="bg-nearblack px-4 py-2 text-body text-white">Create Scope</Link>
          {isAdmin && <Link href={`/projects/${projectId}/estimate`} className="border border-nearblack px-4 py-2 text-body text-nearblack">Open ballpark Estimate</Link>}
        </div>
      </section>
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5">
      <section className="border border-[#dcd6cc] bg-offwhite">
        <div className="flex flex-col gap-4 border-b border-[#dcd6cc] px-4 py-5 md:flex-row md:items-end md:justify-between md:px-5">
          <div>
            <p className="label-caps text-charcoal/55">Connected job plan</p>
            <h1 className="mt-1 font-display text-section text-nearblack">One job, five useful views</h1>
            <p className="mt-1 max-w-3xl text-body text-charcoal/65">
              Scope {initialModel.sow_revision_label} is the wording. Trades, FF&amp;E, quotes and activities connect to it without being entered twice.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href={`/projects/${projectId}/sow`} className="border border-[#c9c2b4] px-3 py-2 text-caption text-nearblack hover:border-nearblack">Edit scope</Link>
            {isAdmin && <Link href={`/projects/${projectId}/estimate`} className="border border-[#c9c2b4] px-3 py-2 text-caption text-nearblack hover:border-nearblack">Open ballpark Estimate</Link>}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-px bg-[#dcd6cc] md:grid-cols-4">
          {[
            ["Scope → trade", `${initialModel.coverage.scope_trade_tagged}/${initialModel.coverage.scope_inclusions}`],
            ["Scope → activity", `${initialModel.coverage.scope_linked_to_activity}/${initialModel.coverage.scope_inclusions}`],
            ["FF&E → activity", `${initialModel.coverage.items_linked_to_activity}/${initialModel.coverage.referenced_items}`],
            [isAdmin ? "Direct prices missing" : "Referenced FF&E", isAdmin ? String(directMissingPrice) : String(initialModel.coverage.referenced_items)],
          ].map(([label, value]) => (
            <div key={label} className="bg-white px-4 py-4">
              <p className="label-caps text-charcoal/45">{label}</p>
              <p className="mt-1 font-display text-section text-nearblack">{value}</p>
            </div>
          ))}
        </div>
      </section>

      {isAdmin && (
        <div className="flex flex-col gap-2 border border-[#d7b96f] bg-[#fffaf0] px-4 py-3 text-body text-charcoal/75 md:flex-row md:items-center md:justify-between">
          <p><span className="font-medium text-nearblack">Ballpark mode remains available.</span> Prefill Estimate lines at any time; this plan identifies exact connections without forcing unfinished scope.</p>
          <Link href={`/projects/${projectId}/estimate`} className="shrink-0 text-caption font-medium text-nearblack underline underline-offset-4">Continue Estimate</Link>
        </div>
      )}

      <div className="flex overflow-x-auto border-b border-[#c9c2b4]" role="tablist" aria-label="Job plan views">
        {VIEWS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={view === item.key}
            onClick={() => setView(item.key)}
            className={clsx(
              "shrink-0 border-b-2 px-4 py-3 text-subhead transition-colors",
              view === item.key ? "border-nearblack text-nearblack" : "border-transparent text-charcoal/55 hover:text-nearblack"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <p className="text-caption text-charcoal/50">Click or tap any row to open its complete thread; double-click works too. Nothing here is a duplicate record.</p>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.key}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="font-display text-subsection text-nearblack">{group.label}</h2>
              <span className="text-caption text-charcoal/45">{group.threads.length} work package{group.threads.length === 1 ? "" : "s"}</span>
            </div>
            <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-white">
              {group.threads.map((thread) => {
                const open = openThreadId === thread.id;
                return (
                  <article
                    key={thread.id}
                    className={clsx("transition-colors", open ? "bg-offwhite" : "hover:bg-[#faf8f3]")}
                  >
                    <button
                      type="button"
                      className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nearblack"
                      aria-expanded={open}
                      onClick={(event) => {
                        if (event.detail === 1) setOpenThreadId(open ? null : thread.id);
                      }}
                      onDoubleClick={() => setOpenThreadId(thread.id)}
                    >
                      <ThreadSummary thread={thread} />
                    </button>
                    {thread.issues.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-t border-[#eee9df] px-4 py-2 md:px-5">
                        {thread.issues.map((issue) => (
                          <Link key={issue.key} href={routeFor(projectId, issue.destination)} className={clsx("border px-2 py-1 text-caption", issue.severity === "attention" ? "border-[#d7b96f] bg-[#fffaf0] text-[#765927]" : "border-[#dcd6cc] text-charcoal/60")}>
                            {issue.label}
                          </Link>
                        ))}
                      </div>
                    )}
                    {open && (
                      <div className="grid gap-5 border-t border-[#c9c2b4] bg-offwhite px-4 py-5 md:grid-cols-2 md:px-5 xl:grid-cols-4">
                        <div className="md:col-span-2 xl:col-span-4">
                          <p className="label-caps text-charcoal/45">Exact scope wording in this package</p>
                          <div className="mt-2 divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-white">
                            {thread.scope_lines.map((line) => (
                              <div key={line.id} className="grid gap-1 px-3 py-2.5 md:grid-cols-[140px_minmax(0,1fr)] md:gap-3">
                                <span className="text-caption font-medium text-charcoal/55">{line.room}</span>
                                <span className="text-body leading-6 text-nearblack">{line.text}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div>
                          <p className="label-caps text-charcoal/45">Scope ownership</p>
                          <p className="mt-2 text-body text-nearblack">{thread.trade ?? "Trade not assigned"}</p>
                          <p className="mt-1 text-caption text-charcoal/55">{thread.contractor_company ?? "Choose the contractor from the project trade roster."}</p>
                          <Link href={`/projects/${projectId}/sow`} className="mt-3 inline-block text-caption font-medium text-nearblack underline underline-offset-4">Edit wording or assignment</Link>
                        </div>

                        <div>
                          <p className="label-caps text-charcoal/45">FF&amp;E referenced in this package</p>
                          <div className="mt-2 space-y-4">
                            {thread.items.map((item) => (
                              <div key={item.id} className="border-l-2 border-sand pl-3">
                                <p className="text-body font-medium text-nearblack">{item.item_code} · {item.name}</p>
                                <p className="mb-2 text-caption text-charcoal/50">{item.quantity} {item.unit} · {item.cost_scope === "direct" ? "Direct purchase" : "Included in trade"}</p>
                                {isAdmin && (
                                  <PriceInput
                                    item={item}
                                    value={prices[item.id] ?? null}
                                    saving={savingId === item.id}
                                    error={priceErrors[item.id] ?? null}
                                    onChange={(value) => setPrices((current) => ({ ...current, [item.id]: value }))}
                                    onSave={() => void savePrice(item.id)}
                                  />
                                )}
                              </div>
                            ))}
                            {thread.items.length === 0 && <p className="text-body text-charcoal/50">No exact project item code appears in this package.</p>}
                          </div>
                          <Link href={`/projects/${projectId}?tab=ffe&view=procurement`} className="mt-3 inline-block text-caption font-medium text-nearblack underline underline-offset-4">Open FF&amp;E</Link>
                        </div>

                        {isAdmin && (
                          <div>
                            <p className="label-caps text-charcoal/45">Estimate and quotes</p>
                            <div className="mt-2 space-y-3">
                              {thread.cost_lines.map((line) => (
                                <div key={line.id}>
                                  <p className="text-body text-nearblack">{line.description}</p>
                                  <p className="text-caption text-charcoal/50">{line.section_name} · {line.cost_ex_gst === null ? "Ballpark not entered" : `${money.format(line.cost_ex_gst)} ex GST`}</p>
                                </div>
                              ))}
                              {thread.quotes.map((quote) => (
                                <div key={quote.id} className="border-l-2 border-[#557a60] pl-3">
                                  <p className="text-body text-nearblack">{quote.title}</p>
                                  <p className="text-caption text-charcoal/50">{quote.status} · {quote.selected_supplier_name ?? (quote.supplier_names.join(", ") || "Supplier not linked")}</p>
                                </div>
                              ))}
                              {thread.cost_lines.length === 0 && thread.quotes.length === 0 && <p className="text-body text-charcoal/50">No exact Estimate or quote link yet. Existing ballpark lines remain in Estimate.</p>}
                            </div>
                            <Link href={`/projects/${projectId}/estimate`} className="mt-3 inline-block text-caption font-medium text-nearblack underline underline-offset-4">Review costing</Link>
                          </div>
                        )}

                        <div>
                          <p className="label-caps text-charcoal/45">Work and programme</p>
                          <div className="mt-2 space-y-3">
                            {thread.activities.map((work) => (
                              <div key={work.id}>
                                <p className="text-body text-nearblack">{work.title}</p>
                                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                                  <StatusDot good={work.status === "Done" || work.status === "Booked"} label={work.status ?? "Status not set"} />
                                  <span className="text-caption text-charcoal/50">{work.phase_name ?? "No phase"}</span>
                                  <span className="text-caption text-charcoal/50">{formatDate(work.booking_date ?? work.due_date)}</span>
                                </div>
                              </div>
                            ))}
                            {thread.activities.length === 0 && <p className="text-body text-charcoal/50">Apply this scope package to create or link the right activity.</p>}
                            {thread.requirements.map((requirement) => (
                              <p key={`${requirement.item_id}:${requirement.board_task_id}`} className="text-caption text-charcoal/60">FF&amp;E required on site: {formatDate(requirement.required_on_site_date)} · {requirement.buffer_days} day buffer</p>
                            ))}
                          </div>
                          <div className="mt-3 flex gap-3">
                            <Link href={`/projects/${projectId}/board`} className="text-caption font-medium text-nearblack underline underline-offset-4">Open Board</Link>
                            <Link href={`/projects/${projectId}/timeline`} className="text-caption font-medium text-nearblack underline underline-offset-4">Open Timeline</Link>
                          </div>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <section className="border border-[#dcd6cc] bg-offwhite p-4 md:p-5">
        <p className="label-caps text-charcoal/55">Connections still to review</p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div><p className="font-display text-subsection text-nearblack">{initialModel.unlinked_items.length}</p><p className="text-body text-charcoal/60">FF&amp;E items not referenced by an exact code in current Scope</p></div>
          <div><p className="font-display text-subsection text-nearblack">{initialModel.unlinked_activities.length}</p><p className="text-body text-charcoal/60">Board activities not linked to a current scope clause</p></div>
          {isAdmin && <div><p className="font-display text-subsection text-nearblack">{initialModel.unlinked_cost_lines.length}</p><p className="text-body text-charcoal/60">Estimate lines without an exact FF&amp;E connection (labour lines may be valid)</p></div>}
        </div>
      </section>
    </div>
  );
}
