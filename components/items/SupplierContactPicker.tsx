"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/types";
import { ContactPicker } from "@/components/shared/ContactPicker";

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
 *
 * Board cockpit round (item 6, "shared searchable ContactPicker
 * replacing existing pickers"): internals now wrap the shared
 * components/shared/ContactPicker.tsx (button+dropdown mode, same as
 * every other non-embedded call site) instead of a second hand-rolled
 * open/search/list implementation — this gets keyboard nav for free.
 * The autofill side-effect (the entire reason this file exists rather
 * than just using ContactPicker directly at its one call site) is
 * PRESERVED exactly: ContactPicker's onSelect only carries a contact
 * id, so this wrapper resolves the full Contact from its own fetched
 * list before computing the same `{ supplier?, supplier_email? }`
 * autofill object as before and calling this component's own `onLink`
 * — components/items/SpecRegister.tsx (protected, this round must not
 * touch it) keeps calling this component with the exact same props,
 * completely unaware of the internal swap.
 */
export function SupplierContactPicker({
  supplierContactId,
  supplierEmpty,
  supplierEmailEmpty,
  onLink,
}: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [linked, setLinked] = useState<Contact | null>(null);

  // Resolve the currently-linked contact's display name (company),
  // independent of whether the picker is open — unchanged from before.
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

  // Fetch-once-on-mount (this round's documented fetch-strategy
  // decision — see ContactPicker.tsx's own header comment — studio
  // contact counts are small, so one fetch handed to ContactPicker's
  // client-side filtering is simpler than a debounced per-keystroke
  // fetch; this mirrors every other non-embedded call site now).
  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, []);

  function pick(contactId: string | null) {
    if (!contactId) {
      onLink(null, {});
      return;
    }
    const contact = contacts.find((c) => c.id === contactId) ?? null;
    if (!contact) {
      // Shouldn't happen (ContactPicker only ever calls onSelect with
      // an id from the same `contacts` list it was handed) — fall back
      // to linking with no autofill rather than silently doing nothing.
      onLink(contactId, {});
      return;
    }
    const autofill: { supplier?: string; supplier_email?: string } = {};
    if (supplierEmpty && contact.company) autofill.supplier = contact.company;
    if (supplierEmailEmpty && contact.email) autofill.supplier_email = contact.email;
    onLink(contact.id, autofill);
  }

  return (
    <ContactPicker
      contacts={contacts}
      selectedId={supplierContactId}
      onSelect={pick}
      placeholder={linked ? `☏ ${linked.company}` : "☏ Link contact"}
    />
  );
}
