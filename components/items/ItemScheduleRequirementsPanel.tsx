"use client";

import { useMemo, useState } from "react";
import type {
  ItemScheduleActivity,
  ItemScheduleRequirement,
} from "@/types/item-schedule-requirements";

function shortDate(value: string | null): string {
  if (!value) return "Date missing";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

export function ItemScheduleRequirementsPanel({
  projectId,
  requirements,
  activities,
  saving,
  onClose,
  onAdd,
  onDelete,
  onBufferChange,
}: {
  projectId: string;
  requirements: ItemScheduleRequirement[];
  activities: ItemScheduleActivity[];
  saving: boolean;
  onClose: () => void;
  onAdd: (boardTaskId: string) => Promise<void>;
  onDelete: (requirementId: string) => Promise<void>;
  onBufferChange: (requirementId: string, bufferDays: number) => Promise<void>;
}) {
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const linkedTaskIds = useMemo(
    () => new Set(requirements.map((requirement) => requirement.board_task_id)),
    [requirements]
  );
  const available = useMemo(
    () => activities.filter((activity) => !linkedTaskIds.has(activity.id)),
    [activities, linkedTaskIds]
  );
  const phaseGroups = useMemo(() => {
    const groups = new Map<string, ItemScheduleActivity[]>();
    for (const activity of available) {
      const key = activity.phase_name ?? "Ungrouped Work";
      const current = groups.get(key) ?? [];
      current.push(activity);
      groups.set(key, current);
    }
    return [...groups.entries()];
  }, [available]);

  async function addSelected() {
    if (!selectedTaskId) return;
    await onAdd(selectedTaskId);
    setSelectedTaskId("");
  }

  return (
    <div className="fixed inset-0 z-50 space-y-4 overflow-y-auto bg-offwhite p-4 sm:static sm:z-auto sm:border sm:border-[#dcd6cc]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-nearblack">Required on site</p>
          <p className="mt-1 max-w-2xl text-body text-charcoal/70">
            Link the Work activity that needs this item. Its works date—or the Timeline phase start until booked—drives Order by and the Finance cash forecast.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`/projects/${projectId}/board`}
            className="text-subhead text-charcoal underline underline-offset-2 hover:text-nearblack"
          >
            Open Work ↗
          </a>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 border border-[#c9c2b4] px-3 text-subhead text-nearblack sm:hidden"
          >
            Close
          </button>
        </div>
      </div>

      {requirements.length > 0 && (
        <div className="space-y-2">
          {requirements.map((requirement) => {
            const activity = requirement.activity;
            return (
              <div
                key={requirement.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border border-[#dcd6cc] bg-cream px-3 py-2"
              >
                <div className="min-w-[220px] flex-1">
                  <p className="text-subhead text-nearblack">
                    {activity ? `${activity.phase_name ? `${activity.phase_name} · ` : ""}${activity.title}` : "Linked activity no longer available"}
                  </p>
                  <p className="mt-0.5 text-caption text-charcoal/60">
                    {activity?.trade_role ?? "Trade role missing"}
                    {activity?.contractor_company ? ` · ${activity.contractor_company}` : ""}
                    {` · ${activity?.booking_date ? "Works" : activity?.phase_start_date ? "Phase starts" : "Schedule missing"} ${shortDate(activity?.required_on_site_date ?? null)}`}
                  </p>
                </div>
                <label className="flex items-center gap-2 text-caption text-charcoal/70">
                  Site buffer
                  <input
                    key={`${requirement.id}:${requirement.buffer_days}`}
                    type="number"
                    min={0}
                    max={365}
                    defaultValue={requirement.buffer_days}
                    disabled={saving}
                    onBlur={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (Number.isInteger(next) && next >= 0 && next <= 365 && next !== requirement.buffer_days) {
                        void onBufferChange(requirement.id, next);
                      }
                    }}
                    className="w-16 border border-[#c9c2b4] bg-white px-2 py-1 text-right text-body focus:border-sand focus:outline-none"
                    aria-label="Site buffer days"
                  />
                  days
                </label>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void onDelete(requirement.id)}
                  className="min-h-9 border border-[#c9c2b4] px-3 text-subhead text-charcoal hover:border-nearblack disabled:opacity-50"
                >
                  Remove link
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={selectedTaskId}
          disabled={saving || available.length === 0}
          onChange={(event) => setSelectedTaskId(event.target.value)}
          className="min-h-11 min-w-0 flex-1 border border-[#c9c2b4] bg-white px-3 text-body focus:border-sand focus:outline-none disabled:opacity-50"
          aria-label="Required Work activity"
        >
          <option value="">{available.length > 0 ? "Choose a Work activity…" : "Every Work activity is already linked"}</option>
          {phaseGroups.map(([phaseName, phaseActivities]) => (
            <optgroup key={phaseName} label={phaseName}>
              {phaseActivities.map((activity) => (
                <option key={activity.id} value={activity.id}>
                  {activity.title}{activity.trade_role ? ` · ${activity.trade_role}` : " · trade missing"}{activity.required_on_site_date ? ` · ${shortDate(activity.required_on_site_date)}` : " · date missing"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          disabled={!selectedTaskId || saving}
          onClick={() => void addSelected()}
          className="min-h-11 bg-nearblack px-4 text-subhead text-white hover:bg-charcoal disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? "Saving…" : "Link activity"}
        </button>
      </div>
    </div>
  );
}
