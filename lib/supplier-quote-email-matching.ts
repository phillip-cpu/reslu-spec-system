const INTERNAL_DOMAIN = "reslu.com.au";

const STOP_WORDS = new Set([
  "a", "all", "an", "and", "around", "as", "at", "by", "during", "existing", "for", "from",
  "general", "in", "install", "installation", "labour", "new", "of", "on", "or", "per", "supply",
  "the", "to", "works", "work", "allowance", "approximately", "please", "project", "quote", "quotation",
  "request", "following", "current", "including", "include", "with",
]);

export type QuoteEmail = {
  id: string;
  subject: string | null;
  clean_text: string | null;
  from_addr: string;
  to_addrs: string[] | null;
  cc_addrs: string[] | null;
  direction: "inbound" | "sent";
  triage_label: string | null;
  received_at: string;
};

export type QuoteProject = {
  id: string;
  name: string;
  alias: string | null;
  job_number: string | null;
  address: string | null;
  client_name: string | null;
};

export type QuoteContact = {
  id: string;
  company: string;
  email: string | null;
  specialty?: string | null;
  category?: string | null;
};

export type QuoteCostLine = {
  id: string;
  project_id: string;
  description: string;
  contact_id: string | null;
  section_name: string;
};

export type QuoteItem = {
  id: string;
  project_id: string;
  item_code: string;
  name: string;
  description?: string | null;
  category: string;
  category_name?: string | null;
  brand?: string | null;
  supplier?: string | null;
  supplier_contact_id?: string | null;
  cost_scope: "direct" | "trade_package";
};

export type EvidenceScore<T> = { value: T; confidence: number; reasons: string[] };
export type QuoteLineMatch = QuoteCostLine & { confidence: number; reason: string; selected: boolean };
export type QuoteItemMatch = QuoteItem & { confidence: number; reason: string; selected: boolean };

export type QuoteThreadMatch = {
  project: EvidenceScore<QuoteProject> | null;
  contact: EvidenceScore<QuoteContact> | null;
  externalEmail: string | null;
  intentConfidence: number;
  intentReason: string;
  lines: QuoteLineMatch[];
  items: QuoteItemMatch[];
  overallConfidence: number;
  canAutoLink: boolean;
  title: string;
  scope: string | null;
};

export type InferredQuoteContact = {
  company: string;
  email: string;
  specialty: string | null;
  confidence: number;
  reason: string;
};

export function normalizeMatchText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle || needle.length < 3) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function coreTokens(value: string): string[] {
  return [...new Set(normalizeMatchText(value).split(" ").filter((token) => token.length >= 3 && !STOP_WORDS.has(token)))];
}

export function externalQuoteAddresses(emails: QuoteEmail[]): string[] {
  const counts = new Map<string, number>();
  for (const email of emails) {
    const candidates = email.direction === "sent"
      ? [...(email.to_addrs ?? []), ...(email.cc_addrs ?? [])]
      : [email.from_addr, ...(email.to_addrs ?? []), ...(email.cc_addrs ?? [])];
    for (const raw of candidates) {
      const address = raw.trim().toLowerCase();
      if (!address || address.endsWith(`@${INTERNAL_DOMAIN}`)) continue;
      counts.set(address, (counts.get(address) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([address]) => address);
}

const GENERIC_EMAIL_DOMAINS = new Set([
  "bigpond.com", "bigpond.com.au", "gmail.com", "hotmail.com", "icloud.com", "live.com",
  "mail.com", "me.com", "outlook.com", "outlook.com.au", "yahoo.com", "yahoo.com.au",
]);
const GENERIC_MAILBOX_NAMES = new Set([
  "accounts", "admin", "contact", "enquiries", "hello", "info", "office", "quotes", "sales",
]);
const COMPANY_WORDS = [
  "adelaide", "appliance", "appliances", "architect", "architects", "building", "buildings",
  "carpentry", "carpenter", "concrete", "construction", "design", "designer", "electrical",
  "engineering", "flooring", "fence", "fences", "fencing", "glass", "glazing", "landscape",
  "landscaping", "painting", "plumbing", "pool", "pools", "precise", "roofing", "stone",
  "tiling", "windows", "zappia",
].sort((left, right) => right.length - left.length);

function segmentCompanyIdentifier(identifier: string): string[] | null {
  const value = identifier.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!value) return null;
  const paths: Array<string[] | null> = Array(value.length + 1).fill(null);
  paths[0] = [];
  for (let index = 0; index < value.length; index++) {
    const path = paths[index];
    if (!path) continue;
    for (const word of COMPANY_WORDS) {
      if (!value.startsWith(word, index)) continue;
      const next = index + word.length;
      const candidate = [...path, word];
      if (!paths[next] || candidate.length < paths[next]!.length) paths[next] = candidate;
    }
  }
  return paths[value.length];
}

function titleCaseCompany(words: string[]): string {
  return words.map((word) => word ? `${word[0].toUpperCase()}${word.slice(1).toLowerCase()}` : "").filter(Boolean).join(" ");
}

function inferSpecialty(emails: QuoteEmail[]): string | null {
  const content = normalizeMatchText(emails.map((email) => `${email.subject ?? ""} ${email.clean_text ?? ""}`).join(" "));
  if (/\bpool\b/.test(content) && /\bfenc(?:e|es|ing)\b/.test(content)) return "Pool fencing";
  if (/\bcarpet\b|\bfloor(?:ing)?\b|\bunderlay\b/.test(content)) return "Flooring";
  if (/\bappliances?\b|\bap schedule\b/.test(content)) return "Appliances";
  if (/\bwindow(?:s)?\b|\bglazing\b|\bglass\b/.test(content)) return "Windows & glazing";
  if (/\belectrical\b|\belectrician\b/.test(content)) return "Electrical";
  if (/\bplumbing\b|\bplumber\b/.test(content)) return "Plumbing";
  if (/\bcarpentry\b|\bcarpenter\b/.test(content)) return "Carpentry";
  if (/\bconcrete\b|\bfooting(?:s)?\b/.test(content)) return "Concreting";
  return null;
}

export function inferQuoteContact(emails: QuoteEmail[], rawEmail: string): InferredQuoteContact | null {
  const email = rawEmail.trim().toLowerCase();
  const match = /^([^@\s]+)@([^@\s]+)$/.exec(email);
  if (!match || match[2] === INTERNAL_DOMAIN || match[2].endsWith(`.${INTERNAL_DOMAIN}`)) return null;

  const local = match[1];
  const domain = match[2];
  const domainLabel = domain.split(".")[0] ?? "";
  const source = GENERIC_EMAIL_DOMAINS.has(domain)
    ? local
    : (GENERIC_MAILBOX_NAMES.has(local) ? domainLabel : domainLabel || local);
  if (!source || GENERIC_MAILBOX_NAMES.has(source)) return null;

  const delimited = source.split(/[._+-]+/).filter((part) => part && !GENERIC_MAILBOX_NAMES.has(part));
  const segmented = delimited.length === 1 ? segmentCompanyIdentifier(delimited[0]) : null;
  const words = segmented && segmented.length > 1 ? segmented : delimited;
  const company = titleCaseCompany(words);
  if (company.length < 2) return null;

  return {
    company,
    email,
    specialty: inferSpecialty(emails),
    confidence: segmented && segmented.length > 1 ? 0.98 : delimited.length > 1 ? 0.93 : 0.86,
    reason: GENERIC_EMAIL_DOMAINS.has(domain) ? "Company inferred from external mailbox" : "Company inferred from external email domain",
  };
}

export function matchQuoteContact(emails: QuoteEmail[], contacts: QuoteContact[]): {
  match: EvidenceScore<QuoteContact> | null;
  externalEmail: string | null;
} {
  const addresses = externalQuoteAddresses(emails);
  const contactsByEmail = new Map<string, QuoteContact[]>();
  for (const contact of contacts) {
    const email = contact.email?.trim().toLowerCase();
    if (!email) continue;
    const rows = contactsByEmail.get(email) ?? [];
    rows.push(contact);
    contactsByEmail.set(email, rows);
  }
  for (const address of addresses) {
    const rows = contactsByEmail.get(address) ?? [];
    if (rows.length === 1) {
      return {
        match: { value: rows[0], confidence: 1, reasons: [`Exact Address Book email: ${address}`] },
        externalEmail: address,
      };
    }
  }
  return { match: null, externalEmail: addresses[0] ?? null };
}

export function matchQuoteProject(emails: QuoteEmail[], projects: QuoteProject[]): EvidenceScore<QuoteProject> | null {
  const subject = normalizeMatchText(emails.map((email) => email.subject ?? "").join(" "));
  const body = normalizeMatchText(emails.map((email) => email.clean_text ?? "").join(" "));
  const combined = `${subject} ${body}`.trim();
  const candidates: EvidenceScore<QuoteProject>[] = [];

  for (const project of projects) {
    let confidence = 0;
    const reasons: string[] = [];
    const name = normalizeMatchText(project.name);
    const alias = normalizeMatchText(project.alias);
    const address = normalizeMatchText(project.address);
    const client = normalizeMatchText(project.client_name);
    const jobNumber = normalizeMatchText(project.job_number);

    if (containsPhrase(subject, name)) { confidence = 1; reasons.push(`Project name in subject: ${project.name}`); }
    else if (containsPhrase(body, name)) { confidence = 0.95; reasons.push(`Project name in message: ${project.name}`); }
    if (alias && containsPhrase(subject, alias)) { confidence = Math.max(confidence, 1); reasons.push(`Project alias in subject: ${project.alias}`); }
    else if (alias && containsPhrase(body, alias)) { confidence = Math.max(confidence, 0.95); reasons.push(`Project alias in message: ${project.alias}`); }
    if (address && containsPhrase(subject, address)) { confidence = Math.max(confidence, 1); reasons.push(`Exact project address in subject: ${project.address}`); }
    else if (address && containsPhrase(body, address)) { confidence = Math.max(confidence, 0.96); reasons.push(`Exact project address in message: ${project.address}`); }
    if (reasons.some((reason) => reason.startsWith("Project name in message") || reason.startsWith("Project alias in message")) && reasons.some((reason) => reason.startsWith("Exact project address in message"))) {
      confidence = Math.max(confidence, 0.99);
    }
    if (jobNumber && new RegExp(`(?:job|project|no|number|#)\\s*0*${jobNumber}\\b`, "i").test(combined)) {
      confidence = Math.max(confidence, 1);
      reasons.push(`Project number: ${project.job_number}`);
    }
    if (client && containsPhrase(subject, client)) { confidence = Math.max(confidence, 0.88); reasons.push(`Client name in subject: ${project.client_name}`); }
    if (confidence > 0) candidates.push({ value: project, confidence, reasons });
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.value.name.localeCompare(b.value.name));
  if (!candidates[0]) return null;
  if (candidates[1] && candidates[0].confidence - candidates[1].confidence < 0.04) return null;
  return candidates[0];
}

export function quoteIntent(emails: QuoteEmail[]): { confidence: number; reason: string } {
  const text = normalizeMatchText(emails.map((email) => `${email.subject ?? ""} ${email.clean_text ?? ""}`).join(" "));
  if (emails.some((email) => email.triage_label === "supplier_quote")) return { confidence: 0.99, reason: "Classified as a supplier quote" };
  if (/\b(?:new )?quote request\b|\brequest(?:ing)? (?:a )?quot|\blooking for (?:a )?quot|\bquotation on\b/.test(text)) {
    return { confidence: 0.99, reason: "Explicit quote request wording" };
  }
  if (/\b(?:attached|find attached|see attached) (?:is |are )?(?:the |our )?(?:quote|quotes|quotation|proposal)\b/.test(text)) {
    return { confidence: 0.96, reason: "Attached quote or proposal wording" };
  }
  if (/\bquote\b|\bquotation\b|\bpricing\b|\bfee proposal\b|\bcosted proposal\b/.test(text)) {
    return { confidence: 0.82, reason: "Possible pricing correspondence" };
  }
  return { confidence: 0, reason: "No quote or pricing intent detected" };
}

function semanticBoost(description: string, content: string): { confidence: number; reason: string } | null {
  if (/\bglass\b/.test(description) && /\bpool\b/.test(description) && /\bfence\b/.test(description) && /\bspigots?\b|\bframeless\b/.test(content)) {
    return { confidence: 0.99, reason: "Pool-fence scope includes glass-hardware wording" };
  }
  if (/\bcarpet\b/.test(description) && /\bunderlay\b|\bcarpet\b|\bsignature score\b/.test(content)) {
    return { confidence: 0.93, reason: "Carpet product/underlay wording" };
  }
  if (/\bwindow\b|\bsliding doors?\b/.test(description) && /\balspec\b|\bproglide\b|\baluminium (?:door|window)/.test(content)) {
    return { confidence: 0.93, reason: "Aluminium door/window system wording" };
  }
  return null;
}

export function matchQuoteLines(emails: QuoteEmail[], lines: QuoteCostLine[], contactId?: string | null): QuoteLineMatch[] {
  const content = normalizeMatchText(emails.map((email) => `${email.subject ?? ""} ${email.clean_text ?? ""}`).join(" "));
  const tokenFrequency = new Map<string, number>();
  for (const line of lines) {
    for (const token of coreTokens(line.description)) tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
  }

  return lines.map((line) => {
    const description = normalizeMatchText(line.description);
    const tokens = coreTokens(line.description);
    const matched = tokens.filter((token) => containsPhrase(content, token));
    const coverage = tokens.length ? matched.length / tokens.length : 0;
    const bigrams = tokens.slice(0, -1).map((token, index) => `${token} ${tokens[index + 1]}`);
    const hasBigram = bigrams.some((phrase) => containsPhrase(content, phrase));
    let confidence = 0;
    let reason = "";

    if (description.length >= 5 && containsPhrase(content, description)) {
      confidence = 1;
      reason = "Exact estimate-line description in email";
    } else if (tokens.length >= 2 && coverage === 1) {
      confidence = 0.97;
      reason = `All distinctive terms matched: ${matched.join(", ")}`;
    } else if (tokens.length === 1 && matched.length === 1 && matched[0].length >= 6 && tokenFrequency.get(matched[0]) === 1) {
      confidence = 0.95;
      reason = `Unique estimate term matched: ${matched[0]}`;
    } else if (hasBigram && coverage >= 0.66) {
      confidence = 0.92;
      reason = `Estimate phrase and ${matched.length}/${tokens.length} terms matched`;
    } else if (matched.length >= 2 && coverage >= 0.5) {
      confidence = 0.84;
      reason = `${matched.length}/${tokens.length} distinctive terms matched`;
    }

    const semantic = semanticBoost(description, content);
    if (semantic && semantic.confidence > confidence) {
      confidence = semantic.confidence;
      reason = semantic.reason;
    }
    if (/\btemporary\b/.test(description) && /\bglass\b|\bspigots?\b|\bframeless\b/.test(content)) {
      confidence = Math.min(confidence, 0.45);
      reason = "Temporary-fence line excluded from permanent glass-fence scope";
    }
    if (contactId && line.contact_id === contactId && confidence >= 0.75) {
      confidence = Math.min(1, confidence + 0.04);
      reason += "; same linked trade";
    }
    return { ...line, confidence, reason, selected: confidence >= 0.95 };
  }).filter((line) => line.confidence >= 0.6).sort((a, b) => b.confidence - a.confidence || a.description.localeCompare(b.description));
}

export function matchQuoteItems(emails: QuoteEmail[], items: QuoteItem[], contactId?: string | null): QuoteItemMatch[] {
  const rawSubject = emails.map((email) => email.subject ?? "").join(" ");
  const content = normalizeMatchText(emails.map((email) => `${email.subject ?? ""} ${email.clean_text ?? ""}`).join(" "));
  const categoryContext = /\b(?:schedule|specification|specifications|pricing|quote|quotation)\b/.test(content);
  const directItems = items.filter((item) => item.cost_scope !== "trade_package");
  const tokenFrequency = new Map<string, number>();
  for (const item of directItems) {
    for (const token of coreTokens(`${item.name} ${item.brand ?? ""}`)) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }
  const hasSpecificItemCode = directItems.some((item) => {
    const itemCode = normalizeMatchText(item.item_code);
    return itemCode.length >= 3 && containsPhrase(content, itemCode);
  });

  return directItems.map((item) => {
    const itemCode = normalizeMatchText(item.item_code);
    const name = normalizeMatchText(item.name);
    const categoryCode = normalizeMatchText(item.category);
    const rawCategoryCode = item.category.trim();
    const categoryName = normalizeMatchText(item.category_name);
    const tokens = coreTokens(`${item.name} ${item.brand ?? ""}`);
    const matched = tokens.filter((token) => containsPhrase(content, token));
    const coverage = tokens.length ? matched.length / tokens.length : 0;
    let confidence = 0;
    let reason = "";

    if (itemCode && containsPhrase(content, itemCode)) {
      confidence = 1;
      reason = `Exact FF&E item code matched: ${item.item_code}`;
    } else if (name.length >= 5 && containsPhrase(content, name)) {
      confidence = 1;
      reason = "Exact FF&E item name in email";
    } else if (
      !hasSpecificItemCode && categoryContext && categoryCode && rawCategoryCode.length >= 2 &&
      new RegExp(`(?:^|[^A-Za-z0-9])${rawCategoryCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z0-9]|$)`).test(rawSubject)
    ) {
      confidence = 0.99;
      reason = `FF&E category schedule matched: ${item.category}`;
    } else if (categoryContext && categoryName && containsPhrase(content, categoryName)) {
      confidence = 0.97;
      reason = `FF&E category matched: ${item.category_name}`;
    } else if (tokens.length >= 2 && coverage === 1) {
      confidence = 0.97;
      reason = `All distinctive FF&E terms matched: ${matched.join(", ")}`;
    } else if (tokens.length === 1 && matched.length === 1 && matched[0].length >= 6 && tokenFrequency.get(matched[0]) === 1) {
      confidence = 0.95;
      reason = `Unique FF&E term matched: ${matched[0]}`;
    } else if (matched.length >= 2 && coverage >= 0.5) {
      confidence = 0.84;
      reason = `${matched.length}/${tokens.length} distinctive FF&E terms matched`;
    }

    if (contactId && item.supplier_contact_id === contactId && confidence >= 0.75) {
      confidence = Math.min(1, confidence + 0.03);
      reason += "; same linked supplier";
    }
    return { ...item, confidence, reason, selected: confidence >= 0.95 };
  }).filter((item) => item.confidence >= 0.6).sort((a, b) => b.confidence - a.confidence || a.item_code.localeCompare(b.item_code));
}

export function buildQuoteThreadMatch(params: {
  emails: QuoteEmail[];
  projects: QuoteProject[];
  contacts: QuoteContact[];
  lines: QuoteCostLine[];
  items?: QuoteItem[];
}): QuoteThreadMatch {
  const project = matchQuoteProject(params.emails, params.projects);
  const { match: contact, externalEmail } = matchQuoteContact(params.emails, params.contacts);
  const intent = quoteIntent(params.emails);
  const projectLines = project ? params.lines.filter((line) => line.project_id === project.value.id) : [];
  const lines = matchQuoteLines(params.emails, projectLines, contact?.value.id);
  const projectItems = project ? (params.items ?? []).filter((item) => item.project_id === project.value.id) : [];
  const items = matchQuoteItems(params.emails, projectItems, contact?.value.id);
  const autoTargets = [...lines, ...items].filter((target) => target.confidence >= 0.95);
  const hasAmbiguousTarget = [...lines, ...items].some((target) => target.confidence >= 0.9 && target.confidence < 0.95);
  const overallConfidence = Math.min(project?.confidence ?? 0, contact?.confidence ?? 0, intent.confidence, autoTargets[0]?.confidence ?? 0);
  const canAutoLink = Boolean(
    project && project.confidence >= 0.98 && contact && contact.confidence === 1 && intent.confidence >= 0.96 && autoTargets.length > 0 && !hasAmbiguousTarget
  );
  const seed = [...params.emails].sort((a, b) => a.received_at.localeCompare(b.received_at))[0];
  const title = (seed?.subject ?? "Existing quote request").replace(/^\s*(?:re|fw|fwd):\s*/i, "").trim();
  const scope = seed?.clean_text?.trim().slice(0, 4000) || null;
  return { project, contact, externalEmail, intentConfidence: intent.confidence, intentReason: intent.reason, lines, items, overallConfidence, canAutoLink, title, scope };
}
