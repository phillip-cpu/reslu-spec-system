"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/types";

interface Props {
  supplierContactId: string | null;
  /** Current supplier/supplier_email — used to decide whether picking a contact should autofill them. */
  supplierEmpty: boolean;
  supplierEmailEmpty: boolean;
  onLink: (contactId: string | null, autofill: { supplier?: string; supplier_email?: string }) => void;
}

/**
 * Supplier contact picker for the item detail panel — BUILD-SPEC.md
 * "Link points": "Item detail panel: supplier contact picker next to
 * supplier fields; picking a contact autofills supplier (company) +
 * supplier_email (email) if those fields are empty." The autofill
 * decision (whether supplier/supplier_email are currently empty) is
 * made by the caller (SpecRegister's ItemRow, which has the live item)
 * and passed in as props — this component only resolves WHICH contact
 * was picked, never inspects item state directly.
 */
export function SupplierContactPicker({
  supplierContactId,
  supplierEmpty,
  supplierEmailEmpty,
  onLink,
}: Props) {
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [linked, setLinked] = useState<Contact | null>(null);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);

  // Resolve the currently-linked contact's display name (company),
  // independent of whether the picker is open.
  useEffect(() => {
    if (!supplierContactId) {
      setLinked(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/contacts/${supplierContactId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!cancelled && body?.contact) setLinked(body.contact as Contact);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [supplierContactId]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, q]);

  function pick(contact: Contact | null) {
    setOpen(false);
    if (!contact) {
      onLink(null, {});
      return;
    }
    const autofill: { supplier?: string; supplier_email?: string } = {};
    if (supplierEmpty && contact.company) autofill.supplier = contact.company;
    if (supplierEmailEmpty && contact.email) autofill.supplier_email = contact.email;
    onLink(contact.id, autofill);
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal transition-colors hover:border-nearblack hover:text-nearblack"
        title="Link to an Address Book contact — autofills supplier/email if empty"
      >
        {linked ? `☏ ${linked.company}` : "☏ Link contact"}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 max-w-[calc(100vw-2rem)] space-y-2 border border-[#dcd6cc] bg-nearwhite p-3 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <p className="label-caps">Link a contact</p>
            <button type="button" onClick={() => setOpen(false)} className="text-caption text-charcoal/50 hover:text-nearblack">
              Close
            </button>
          </div>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company…"
            className="w-full border border-[#c9c2b4] bg-cream px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
          <div className="max-h-48 overflow-y-auto">
            <button
              type="button"
              onClick={() => pick(null)}
              className="block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body text-charcoal/60 hover:bg-cream"
            >
              No link
            </button>
            {loading ? (
              <p className="px-2 py-2 text-caption text-charcoal/50">Loading…</p>
            ) : contacts.length === 0 ? (
              <p className="px-2 py-2 text-caption text-charcoal/50">No contacts match.</p>
            ) : (
              contacts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c)}
                  className={
                    "block w-full border-b border-[#e5e0d6] px-2 py-1.5 text-left text-body hover:bg-cream " +
                    (supplierContactId === c.id ? "bg-cream text-nearblack" : "text-charcoal")
                  }
                >
                  {c.company}
                  {c.contact_name ? ` — ${c.contact_name}` : ""}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
