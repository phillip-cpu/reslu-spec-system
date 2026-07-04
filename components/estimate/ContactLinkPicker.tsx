"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/types";

interface Props {
  currentContactId: string | null;
  onSelect: (contactId: string | null) => void;
  onClose: () => void;
}

/**
 * Contact picker for a cost line — BUILD-SPEC.md "Link points": "small
 * contact picker ... showing company — selecting also autofills the
 * line's notes? NO — just stores the link and shows company name
 * chip." Mirrors components/estimate/ItemLinkPicker.tsx's shape
 * (search box + scrollable list + "No link" affordance), fetching from
 * GET /api/contacts (this feature's own read route) rather than a
 * project-scoped endpoint — the Address Book is global, not per-project.
 */
export function ContactLinkPicker({ currentContactId, onSelect, onClose }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      fetch(`/api/contacts?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((body) => setContacts(body.contacts ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  return (
    <div className="max-w-xl space-y-2 border border-[#dcd6cc] bg-nearwhite p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="label-caps">Link to a contact</p>
        <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
          Close
        </button>
      </div>
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search company, contact, specialty…"
        className="w-full border border-[#c9c2b4] bg-cream px-3 py-1.5 text-body focus:border-nearblack focus:outline-none"
      />
      {loading ? (
        <p className="text-caption text-charcoal/50">Loading…</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
          >
            No link
          </button>
          {contacts.length === 0 ? (
            <p className="px-2 py-2 text-caption text-charcoal/50">No contacts match.</p>
          ) : (
            contacts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                className={
                  "flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body hover:bg-cream " +
                  (currentContactId === c.id ? "bg-cream text-nearblack" : "text-charcoal")
                }
              >
                <span>
                  {c.company}
                  {c.contact_name ? ` — ${c.contact_name}` : ""}
                </span>
                {c.category && <span className="text-caption text-charcoal/40">{c.category}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
