/**
 * RESLU Second Brain, Step 5 (docs/RESLU-second-brain-build-brief.md).
 * contentFor() composes the (title, content) pair workspace_index
 * stores per record. One row per record, no chunking — content is a
 * plain joined string of the record's key fields, not a full dump.
 *
 * Two of the brief's own table-name assumptions were wrong and are
 * corrected here (confirmed against this repo's actual migrations,
 * not the brief's guess): "diary" is `portal_updates`, not a
 * `diary_entries` table that doesn't exist. "sow" is three joined
 * tables (sow_documents -> sow_sections -> sow_lines), not a single
 * `sow_entries` table.
 *
 * Phase 2 also indexes inbound/sent email history and durable brain_notes. Local
 * OpenClaw skill files still cannot be reached from Vercel and remain
 * outside this index.
 */

export type ContentEntityType = "project" | "lead" | "item" | "diary" | "sow" | "email" | "memory";

export type IndexableProject = {
  id: string;
  name: string;
  client_name: string | null;
  address: string | null;
  status: string | null;
  alias: string | null;
  job_number: string | null;
};

export type IndexableLead = {
  id: string;
  first_name: string | null;
  surname_project: string | null;
  stage: string | null;
  source: string | null;
  location: string | null;
  email: string | null;
  phone: string | null;
};

export type IndexableItem = {
  id: string;
  item_code: string;
  name: string;
  category: string | null;
  description: string | null;
  supplier: string | null;
  brand: string | null;
  location: string | null;
  colour: string | null;
  material: string | null;
  finish: string | null;
  status: string | null;
  price_rrp: number | null;
  price_trade: number | null;
};

export type IndexablePortalUpdate = {
  id: string;
  title: string | null;
  body_richtext: string | null;
};

export type IndexableSowDocument = {
  id: string;
  revision_label: string | null;
  project_name: string;
  sections: { heading: string | null; lines: string[] }[];
};

export type IndexableEmail = {
  id: string;
  from_addr: string;
  subject: string | null;
  received_at: string;
  direction: "inbound" | "sent";
  clean_text: string | null;
  attachment_text: string | null;
  triage_label: string | null;
  status: string;
  matched_project_id: string | null;
};

export type IndexableBrainNote = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source: string;
  source_ref: string | null;
  confidence: number | null;
  created_at: string;
};

function joinFields(fields: (string | number | null | undefined)[]): string {
  return fields
    .filter((f): f is string | number => f !== null && f !== undefined && f !== "")
    .join(" — ");
}

export function contentForProject(p: IndexableProject): { title: string; content: string } {
  return {
    title: p.name,
    content: joinFields([p.name, p.client_name, p.address, p.status, p.alias, p.job_number]),
  };
}

export function contentForLead(l: IndexableLead): { title: string; content: string } {
  const title = [l.first_name, l.surname_project].filter(Boolean).join(" ") || "(unnamed lead)";
  return {
    title,
    content: joinFields([title, l.stage, l.source, l.location, l.email, l.phone]),
  };
}

export function contentForItem(i: IndexableItem): { title: string; content: string } {
  const title = `${i.item_code} — ${i.name}`;
  return {
    title,
    content: joinFields([
      title,
      i.category,
      i.description,
      i.supplier,
      i.brand,
      i.location,
      i.colour,
      i.material,
      i.finish,
      i.status,
      i.price_rrp != null ? `RRP $${i.price_rrp}` : null,
      i.price_trade != null ? `Trade $${i.price_trade}` : null,
    ]),
  };
}

export function contentForDiary(d: IndexablePortalUpdate): { title: string; content: string } {
  const title = d.title ?? "(untitled update)";
  return {
    title,
    content: joinFields([title, d.body_richtext]),
  };
}

export function contentForSow(s: IndexableSowDocument): { title: string; content: string } {
  const title = `SOW — ${s.project_name} — ${s.revision_label ?? "(no revision label)"}`;
  const sectionText = s.sections
    .map((sec) => joinFields([sec.heading, sec.lines.join("; ")]))
    .filter(Boolean)
    .join(" | ");
  return {
    title,
    content: joinFields([title, sectionText]),
  };
}

export function contentForEmail(email: IndexableEmail): { title: string; content: string } {
  const title = email.subject || "(no subject)";
  return {
    title,
    content: joinFields([
      title,
      `From ${email.from_addr}`,
      `Received ${email.received_at}`,
      `Direction ${email.direction}`,
      email.triage_label ? `Triage ${email.triage_label}` : null,
      `Status ${email.status}`,
      email.matched_project_id ? `Project ${email.matched_project_id}` : null,
      // Keep the index useful without feeding an unbounded email chain
      // into a single embedding record. The full source remains in emails.
      email.clean_text?.slice(0, 12_000),
      email.attachment_text?.slice(0, 12_000),
    ]),
  };
}

export function contentForMemory(note: IndexableBrainNote): { title: string; content: string } {
  return {
    title: note.title,
    content: joinFields([
      note.title,
      note.body,
      note.tags.length ? `Tags ${note.tags.join(", ")}` : null,
      `Source ${note.source}`,
      note.source_ref ? `Source reference ${note.source_ref}` : null,
      note.confidence != null ? `Confidence ${note.confidence}` : null,
      `Recorded ${note.created_at}`,
    ]),
  };
}
