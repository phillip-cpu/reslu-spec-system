"use client";

import { useEffect, useState } from "react";
import type { Contact } from "@/types";
import { ContactPicker } from "@/components/shared/ContactPicker";

interface Props {
  currentContactId: string | null;
  onSelect: (contactId: string | null) => void;
  onClose: () => void;
}

/**
 * Contact picker for a cost line — BUILD-SPEC.md "Link points": "small
 * contact picker ... showing company — selecting also autofills the
 * line's notes? NO — just stores the link and shows company name
 * chip."
 *
 * Board cockpit round (item 6, "shared searchable ContactPicker
 * replacing existing pickers"): this component is now a thin wrapper
 * delegating its search box + list + keyboard nav entirely to the
 * shared components/shared/ContactPicker.tsx (its `embedded` mode —
 * see that component's doc comment for why an always-open embedded
 * mode exists alongside its normal button+dropdown mode), rather than
 * duplicating that rendering/filtering logic here a second time. Only
 * this file's own concern remains: fetching the global contacts list
 * ONCE (GET /api/contacts, this feature's own read route, no project
 * scoping — the Address Book is global, not per-project) and handing
 * it down, plus preserving this component's exact external contract
 * (currentContactId/onSelect/onClose) so its one call site
 * (components/estimate/EstimateView.tsx) needs no changes.
 */
export function ContactLinkPicker({ currentContactId, onSelect, onClose }: Props) {
  const [contacts, setContacts] = useState<Contact[]>([]);

  useEffect(() => {
    fetch("/api/contacts")
      .then((r) => r.json())
      .then((body) => setContacts(body.contacts ?? []))
      .catch(() => {});
  }, []);

  return (
    <ContactPicker
      contacts={contacts}
      selectedId={currentContactId}
      onSelect={onSelect}
      embedded
      onClose={onClose}
    />
  );
}
