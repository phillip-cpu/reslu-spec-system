const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requiredText(value, label, maxLength = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function optionalText(value, label, maxLength = 1000) {
  if (value == null || value === "") return null;
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

export function normalizeContactItemLinkInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Input must be an object");
  const email = requiredText(value.email, "email", 320).toLowerCase();
  if (!EMAIL.test(email)) throw new Error("email must be valid");
  return {
    project_id: requiredText(value.project_id, "project_id", 100),
    item_id: requiredText(value.item_id, "item_id", 100),
    item_code: requiredText(value.item_code, "item_code", 40).toUpperCase(),
    company: requiredText(value.company, "company", 300),
    contact_name: requiredText(value.contact_name, "contact_name", 300),
    email,
    phone: optionalText(value.phone, "phone", 100),
    mobile: optionalText(value.mobile, "mobile", 100),
    address: optionalText(value.address, "address", 500),
    specialty: optionalText(value.specialty, "specialty", 300) ?? "Flooring",
    category: optionalText(value.category, "category", 300) ?? "Flooring",
  };
}

export function chooseExactEmailContact(contacts, email) {
  const matches = (Array.isArray(contacts) ? contacts : []).filter(
    (contact) => contact?.deleted_at == null && String(contact?.email ?? "").trim().toLowerCase() === email,
  );
  if (matches.length > 1) throw new Error(`Multiple active contacts use ${email}; resolve the duplicate before linking`);
  return matches[0] ?? null;
}

export function mergeVerifiedContactNotes(existing, { mobile, address }) {
  const kept = String(existing ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Mobile:/i.test(line) && !/^Address:/i.test(line));
  if (mobile) kept.push(`Mobile: ${mobile}`);
  if (address) kept.push(`Address: ${address}`);
  return kept.length ? kept.join("\n") : null;
}

export function assertItemCanBeLinked(item, input, contactId) {
  if (!item || typeof item !== "object") throw new Error("Item was not found");
  if (item.project_id !== input.project_id) throw new Error("Item does not belong to the supplied project");
  if (String(item.item_code ?? "").toUpperCase() !== input.item_code) throw new Error("Item code does not match the supplied item");
  if (item.supplier_contact_id && item.supplier_contact_id !== contactId) {
    throw new Error("Item is already linked to a different supplier contact; review it before replacing the link");
  }
}
