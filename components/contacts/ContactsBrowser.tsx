"use client";

import { useEffect, useMemo, useState } from "react";
import type { Contact } from "@/types";
import type { InsuranceStatus } from "@/lib/insurance";
import { ContactDocumentsPanel } from "./ContactDocumentsPanel";

interface Props {
  /** Distinct existing category values, for the filter dropdown and the add-form's autocomplete suggestions. */
  categories: string[];
}

/** Contact rows as returned by GET /api/contacts (Fix Round A adds insurance_status/document_count; Quick items round 6 July 2026 adds insurance_required — see that route's doc comment). */
type ContactWithInsurance = Contact & {
  insurance_required: boolean;
  insurance_status: InsuranceStatus;
  document_count: number;
};

const UNCATEGORISED = "Uncategorised";

const STATUS_LABEL: Record<InsuranceStatus, string> = {
  current: "Insurance current",
  expiring: "Insurance expiring soon",
  expired: "Insurance expired",
  missing: "Insurance missing",
};

/** Badge colour classes — brand-safe: sand for the neutral/good state, amber-ish charcoal border for expiring, red only for the two states that actually need action (matches this codebase's existing red-for-overdue convention, e.g. isPastDue in ProjectBoard.tsx/lib/leads.ts). */
const STATUS_BADGE_CLASS: Record<InsuranceStatus, string> = {
  current: "border-[#c9c2b4] text-charcoal/50",
  expiring: "border-sand text-sand",
  expired: "border-red-700/50 text-red-700",
  missing: "border-red-700/50 text-red-700",
};

/**
 * Address Book browser — BUILD-SPEC.md "Address Book": "searchable
 * list grouped/filterable by category, add/edit inline or side panel,
 * soft delete." Mirrors components/library/LibraryBrowser.tsx's shape
 * (debounced search + category filter + add form + card grid), grouped
 * by category since a directory of ~30 trade categories reads better
 * grouped than as one flat list (unlike the Library, which has a
 * bounded ~20-category taxonomy already surfaced via a dropdown only).
 *
 * FIX ROUND A — Trade insurance tracker: every card now shows an
 * insurance status badge and an expand toggle revealing a documents
 * panel (upload/list/delete, expiry date input) — see
 * ContactDocumentsPanel below.
 *
 * Quick items round (6 July 2026), item 1 — "Insurance required flag":
 * the badge's visibility now follows the explicit
 * `insurance_required` column (migration 026) instead of a
 * category-based guess — a contact only ever shows a badge when a
 * human has ticked "Certificate needed" for it (in
 * ContactDocumentsPanel's expand panel) OR it already has at least one
 * document on file (so a contact that was never flagged but has, say,
 * a licence uploaded anyway still shows its status rather than hiding
 * it). This replaces the old isTradeCategory()-driven showBadge check.
 */
export function ContactsBrowser({ categories: initialCategories }: Props) {
  const [contacts, setContacts] = useState<ContactWithInsurance[]>([]);
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [knownCategories, setKnownCategories] = useState<string[]>(initialCategories);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (categoryFilter) params.set("category", categoryFilter);
      fetch(`/api/contacts?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setContacts(d.contacts ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, categoryFilter]);

  function noteCategory(cat: string | null) {
    if (!cat) return;
    setKnownCategories((cur) => (cur.includes(cat) ? cur : [...cur, cat].sort((a, b) => a.localeCompare(b))));
  }

  // POST /api/contacts and PATCH /api/contacts/[id] both `.select()`
  // and return a plain `contacts` row — this DOES include the real
  // `insurance_required` column now (it's a stored column, migration
  // 026) but NOT `insurance_status`/`document_count` (those are GET
  // /api/contacts-only computed fields, see that route's doc comment).
  // A just-created contact always has insurance_required defaulted
  // false (the column's DB default) and zero documents, so it never
  // shows a badge until someone ticks "Certificate needed" or uploads
  // a document — safe to hardcode both here for a brand-new row.
  function prepend(contact: Contact) {
    setContacts((cur) => [{ ...contact, insurance_required: false, insurance_status: "current", document_count: 0 }, ...cur]);
    noteCategory(contact.category);
  }
  function remove(id: string) {
    setContacts((cur) => cur.filter((c) => c.id !== id));
  }
  function patch(id: string, next: Contact) {
    setContacts((cur) => cur.map((c) => (c.id === id ? { ...c, ...next } : c)));
    noteCategory(next.category);
  }

  const groups = useMemo(() => {
    const map = new Map<string, ContactWithInsurance[]>();
    for (const c of contacts) {
      const key = c.category?.trim() || UNCATEGORISED;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return [...map.entries()]
      .sort((a, b) => {
        if (a[0] === UNCATEGORISED) return 1;
        if (b[0] === UNCATEGORISED) return -1;
        return a[0].localeCompare(b[0]);
      })
      .map(([category, rows]) => ({
        category,
        rows: rows.sort((a, b) => a.company.localeCompare(b.company)),
      }));
  }, [contacts]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search company, contact, specialty…"
          className="min-w-[240px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
        >
          <option value="">All categories</option>
          {initialCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setAdding((a) => !a);
            setEditingId(null);
          }}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
        >
          {adding ? "Close" : "New contact"}
        </button>
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {adding && (
        <ContactForm
          knownCategories={knownCategories}
          onError={setError}
          onSaved={(contact) => {
            prepend(contact);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {loading ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : contacts.length === 0 ? (
        <div className="border border-dashed border-[#c9c2b4] p-12 text-center">
          <p className="text-body text-charcoal/60">
            {q || categoryFilter
              ? "No contacts match your search."
              : "The address book is empty. Add your first contact."}
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.category}>
              <div className="mb-2 flex items-baseline justify-between border-b border-nearblack pb-1">
                <h2 className="label-caps !text-nearblack">{group.category}</h2>
                <span className="text-caption text-charcoal/50">{group.rows.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
                {group.rows.map((contact) =>
                  editingId === contact.id ? (
                    <ContactForm
                      key={contact.id}
                      knownCategories={knownCategories}
                      initial={contact}
                      onError={setError}
                      onSaved={(next) => {
                        patch(contact.id, next);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <div key={contact.id} className="contents">
                      <ContactCard
                        contact={contact}
                        expanded={expandedId === contact.id}
                        onToggleExpand={() => setExpandedId((cur) => (cur === contact.id ? null : contact.id))}
                        onEdit={() => {
                          setEditingId(contact.id);
                          setAdding(false);
                        }}
                        onDelete={async () => {
                          if (!confirm(`Remove "${contact.company}" from the address book?`)) return;
                          remove(contact.id);
                          const res = await fetch(`/api/contacts/${contact.id}`, { method: "DELETE" });
                          if (!res.ok) {
                            setError("Could not delete contact");
                            prepend(contact);
                          }
                        }}
                      />
                      {expandedId === contact.id && (
                        <div className="md:col-span-2 lg:col-span-3">
                          <ContactDocumentsPanel
                            contactId={contact.id}
                            insuranceRequired={contact.insurance_required}
                            onCountChange={(count) =>
                              setContacts((cur) =>
                                cur.map((c) =>
                                  c.id === contact.id
                                    ? { ...c, document_count: count }
                                    : c
                                )
                              )
                            }
                            onStatusChange={(status) =>
                              setContacts((cur) =>
                                cur.map((c) => (c.id === contact.id ? { ...c, insurance_status: status } : c))
                              )
                            }
                            onInsuranceRequiredChange={(required) =>
                              setContacts((cur) =>
                                cur.map((c) => (c.id === contact.id ? { ...c, insurance_required: required } : c))
                              )
                            }
                          />
                        </div>
                      )}
                    </div>
                  )
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function ContactCard({
  contact,
  expanded,
  onToggleExpand,
  onEdit,
  onDelete,
}: {
  contact: ContactWithInsurance;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const showBadge = contact.insurance_required || contact.document_count > 0;
  return (
    <article className="flex flex-col justify-between border border-[#dcd6cc] bg-offwhite p-4">
      <div>
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-subhead text-nearblack">{contact.company}</h3>
          {showBadge && (
            <span
              className={`shrink-0 border px-2 py-0.5 text-caption uppercase tracking-wide ${STATUS_BADGE_CLASS[contact.insurance_status]}`}
              title={STATUS_LABEL[contact.insurance_status]}
            >
              {STATUS_LABEL[contact.insurance_status]}
            </span>
          )}
        </div>
        {contact.contact_name && (
          <p className="mt-1 text-body text-charcoal/70">{contact.contact_name}</p>
        )}
        <div className="mt-1 space-y-0.5 text-body text-charcoal/60">
          {contact.phone && <p>{contact.phone}</p>}
          {contact.email && (
            <p>
              <a href={`mailto:${contact.email}`} className="hover:text-nearblack hover:underline">
                {contact.email}
              </a>
            </p>
          )}
          {contact.website && (
            <p>
              <a
                href={contact.website.startsWith("http") ? contact.website : `https://${contact.website}`}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-nearblack hover:underline"
              >
                {contact.website}
              </a>
            </p>
          )}
        </div>
        {contact.specialty && (
          <p className="mt-2 text-caption text-charcoal/50">{contact.specialty}</p>
        )}
        {contact.notes && (
          <p className="mt-1 text-caption text-sand">{contact.notes}</p>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-[#dcd6cc] pt-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onEdit}
            className="text-caption text-charcoal/60 hover:text-nearblack"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onToggleExpand}
            className="text-caption text-charcoal/60 hover:text-nearblack"
          >
            {expanded ? "Hide documents" : `Documents${contact.document_count ? ` (${contact.document_count})` : ""}`}
          </button>
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="text-caption text-charcoal/50 hover:text-red-700"
        >
          Delete
        </button>
      </div>
    </article>
  );
}

function ContactForm({
  initial,
  knownCategories,
  onSaved,
  onError,
  onCancel,
}: {
  initial?: Contact;
  knownCategories: string[];
  onSaved: (contact: Contact) => void;
  onError: (msg: string | null) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({
    company: initial?.company ?? "",
    contact_name: initial?.contact_name ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    website: initial?.website ?? "",
    specialty: initial?.specialty ?? "",
    category: initial?.category ?? "",
    notes: initial?.notes ?? "",
  });
  const [submitting, setSubmitting] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.company.trim()) return;
    setSubmitting(true);
    onError(null);
    try {
      const body = {
        company: form.company.trim(),
        contact_name: form.contact_name.trim() || null,
        phone: form.phone.trim() || null,
        email: form.email.trim() || null,
        website: form.website.trim() || null,
        specialty: form.specialty.trim() || null,
        category: form.category.trim() || null,
        notes: form.notes.trim() || null,
      };
      const res = await fetch(initial ? `/api/contacts/${initial.id}` : "/api/contacts", {
        method: initial ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { contact } = await res.json();
      onSaved(contact);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSubmitting(false);
    }
  }

  const field =
    "border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none";

  return (
    <form
      onSubmit={submit}
      className="grid grid-cols-1 gap-3 border border-[#dcd6cc] bg-offwhite p-4 sm:grid-cols-3"
    >
      <label className="flex flex-col gap-1 sm:col-span-2">
        <span className="label-caps">Company</span>
        <input required autoFocus value={form.company} onChange={(e) => set("company", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Category</span>
        <input
          value={form.category}
          onChange={(e) => set("category", e.target.value)}
          list="contact-category-suggestions"
          placeholder="e.g. Carpenters"
          className={field}
        />
        <datalist id="contact-category-suggestions">
          {knownCategories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Contact name</span>
        <input value={form.contact_name} onChange={(e) => set("contact_name", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Phone</span>
        <input value={form.phone} onChange={(e) => set("phone", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Email</span>
        <input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Website</span>
        <input value={form.website} onChange={(e) => set("website", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="label-caps">Specialty</span>
        <input value={form.specialty} onChange={(e) => set("specialty", e.target.value)} className={field} />
      </label>
      <label className="flex flex-col gap-1 sm:col-span-3">
        <span className="label-caps">Notes</span>
        <input value={form.notes} onChange={(e) => set("notes", e.target.value)} className={field} />
      </label>
      <div className="flex items-center gap-2 sm:col-span-3">
        <button
          type="submit"
          disabled={submitting}
          className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {submitting ? "Saving…" : initial ? "Save changes" : "Save contact"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
