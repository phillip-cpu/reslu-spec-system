export type AriaEmailInput = {
  to: string;
  cc?: string[];
  subject: string;
  body: string;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAriaEmailInput(value: unknown): AriaEmailInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Email payload must be an object");
  const input = value as Record<string, unknown>;
  const to = typeof input.to === "string" ? input.to.trim().toLowerCase() : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const cc = input.cc === undefined ? [] : input.cc;
  if (!EMAIL.test(to)) throw new Error("A valid final recipient is required");
  if (!Array.isArray(cc) || cc.length > 10 || cc.some((item) => typeof item !== "string" || !EMAIL.test(item.trim()))) {
    throw new Error("CC must contain at most 10 valid email addresses");
  }
  if (!subject || subject.length > 300) throw new Error("Subject must be 1-300 characters");
  if (!body || body.length > 50000) throw new Error("Body must be 1-50000 characters");
  return { to, cc: cc.map((item) => String(item).trim().toLowerCase()), subject, body };
}
