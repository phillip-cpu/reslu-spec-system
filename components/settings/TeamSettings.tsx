"use client";

import { useState } from "react";
import type { Profile, ProfileRole } from "@/types";

interface Props {
  initialTeam: Profile[];
  canEdit: boolean;
  currentUserId: string;
}

const ROLES: ProfileRole[] = ["admin", "designer", "viewer"];

/**
 * Team roster with admin-only role editing (BUILD-SPEC.md §Settings:
 * "Role assignment lives in Settings, admin-only" / Financial
 * visibility §"Two roles: admin ... and team"). The schema itself
 * supports three roles (admin/designer/viewer — migration
 * 001_initial.sql's check constraint); "team" in the brief covers both
 * non-admin roles, so the select offers all three rather than
 * collapsing them.
 *
 * Writes go through PATCH /api/profiles/[id], which enforces
 * admin-only server-side and blocks a last-admin self-demotion.
 */
export function TeamSettings({ initialTeam, canEdit, currentUserId }: Props) {
  const [team, setTeam] = useState<Profile[]>(initialTeam);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function changeRole(profileId: string, role: ProfileRole) {
    const prev = team;
    setTeam((t) => t.map((p) => (p.id === profileId ? { ...p, role } : p)));
    setSavingId(profileId);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profileId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not update role");
      }
    } catch (err) {
      setTeam(prev);
      setError(err instanceof Error ? err.message : "Could not update role");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="max-w-lg space-y-3">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}
      <ul className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
        {team.map((p) => {
          const isSelf = p.id === currentUserId;
          const isLastAdmin =
            p.role === "admin" && team.filter((t) => t.role === "admin").length <= 1;
          return (
            <li key={p.id} className="flex items-center justify-between px-4 py-3 gap-4">
              <div>
                <p className="text-body text-nearblack">
                  {p.full_name}
                  {isSelf && <span className="text-charcoal/40"> (you)</span>}
                </p>
                <p className="text-caption text-charcoal/50">{p.email}</p>
              </div>
              {canEdit ? (
                <select
                  value={p.role}
                  disabled={savingId === p.id || (isSelf && isLastAdmin)}
                  title={
                    isSelf && isLastAdmin
                      ? "You are the last admin — promote someone else first."
                      : undefined
                  }
                  onChange={(e) => changeRole(p.id, e.target.value as ProfileRole)}
                  className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="label-caps">{p.role}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-caption text-charcoal/50">
        Add or remove team members in the Supabase dashboard
        (Authentication → Users). New users get a profile automatically.
      </p>
    </div>
  );
}
