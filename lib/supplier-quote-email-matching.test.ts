import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQuoteThreadMatch,
  inferQuoteContact,
  matchQuoteContact,
  matchQuoteItems,
  matchQuoteLines,
  matchQuoteProject,
  quoteIntent,
  type QuoteContact,
  type QuoteCostLine,
  type QuoteEmail,
  type QuoteItem,
  type QuoteProject,
} from "./supplier-quote-email-matching.ts";

const hone: QuoteProject = {
  id: "hone",
  name: "Hone",
  alias: "Evandale",
  job_number: "026",
  address: "4 Belinda Street, Evandale",
  client_name: "Dale Hone",
};
const otherProject: QuoteProject = { id: "other", name: "Jones", alias: null, job_number: "027", address: "9 Other Road, Norwood", client_name: "Sam Jones" };
const poolContact: QuoteContact = { id: "pool-contact", company: "Adelaide Pool Glass", email: "adelaidepoolglass@mail.com" };
const poolLines: QuoteCostLine[] = [
  { id: "glass", project_id: "hone", description: "GLASS POOL FENCE", contact_id: null, section_name: "Glazing" },
  { id: "footing", project_id: "hone", description: "Strip Footing for glass Pool fence", contact_id: null, section_name: "Earthworks / Footings" },
  { id: "temporary", project_id: "hone", description: "Temporary Pool Fence", contact_id: null, section_name: "Preliminaries & Site" },
];
const applianceItems: QuoteItem[] = [
  { id: "oven", project_id: "hone", item_code: "AP-01", name: "Pyrolytic Oven", category: "AP", category_name: "Appliances", cost_scope: "direct" },
  { id: "cooktop", project_id: "hone", item_code: "AP-02", name: "Induction Cooktop", category: "AP", category_name: "Appliances", cost_scope: "direct" },
  { id: "install", project_id: "hone", item_code: "AP-03", name: "Appliance installation", category: "AP", category_name: "Appliances", cost_scope: "trade_package" },
];

function email(overrides: Partial<QuoteEmail> = {}): QuoteEmail {
  return {
    id: "email-1",
    subject: "NEW QUOTE REQUEST - Hone | Evandale - Pool Fence",
    clean_text: "We will supply a new strip footing for the fence, approximately 8m long with one gate. Do you have an option for black spigots?",
    from_addr: "phillip@reslu.com.au",
    to_addrs: ["adelaidepoolglass@mail.com"],
    cc_addrs: [],
    direction: "sent",
    triage_label: null,
    received_at: "2026-08-28T03:12:42Z",
    ...overrides,
  };
}

test("matches an outside-system sent email to the exact Address Book recipient", () => {
  const result = matchQuoteContact([email()], [
    { id: "reslu", company: "TEST RESLU", email: "phillip@reslu.com.au" },
    poolContact,
  ]);
  assert.equal(result.externalEmail, poolContact.email);
  assert.equal(result.match?.value.id, poolContact.id);
  assert.equal(result.match?.confidence, 1);
});

test("uses project name, address, alias, and job number without accepting an ambiguous project", () => {
  assert.equal(matchQuoteProject([email()], [hone, otherProject])?.value.id, "hone");
  assert.equal(matchQuoteProject([email({ subject: "Pricing", clean_text: "Please quote project #026 at 4 Belinda Street, Evandale" })], [hone, otherProject])?.confidence, 1);
  const duplicate = { ...hone, id: "hone-copy" };
  assert.equal(matchQuoteProject([email()], [hone, duplicate]), null);
});

test("recognises explicit request and attached-quote language but ignores ordinary project mail", () => {
  assert.equal(quoteIntent([email()]).confidence, 0.99);
  assert.equal(quoteIntent([email({ subject: "Re: Hone", clean_text: "Please see attached quotes for the AP Schedule" })]).confidence, 0.96);
  assert.equal(quoteIntent([email({ subject: "Hone concept plan", clean_text: "Please review the latest design." })]).confidence, 0);
});

test("ranks both glass pool fence and strip footing above a temporary fence", () => {
  const lines = matchQuoteLines([email()], poolLines);
  assert.deepEqual(lines.filter((line) => line.selected).map((line) => line.id).sort(), ["footing", "glass"]);
  assert.equal(lines.some((line) => line.id === "temporary"), false);
});

test("infers auditable supplier details from external quote recipients", () => {
  assert.deepEqual(inferQuoteContact([email()], "adelaidepoolglass@mail.com"), {
    company: "Adelaide Pool Glass",
    email: "adelaidepoolglass@mail.com",
    specialty: "Pool fencing",
    confidence: 0.98,
    reason: "Company inferred from external mailbox",
  });
  assert.equal(inferQuoteContact([email()], "info@precisepoolfencing.com.au")?.company, "Precise Pool Fencing");
  assert.equal(inferQuoteContact([email()], "phillip@reslu.com.au"), null);
});

test("an FF&E schedule links every direct item in the named category", () => {
  const result = matchQuoteItems([email({ subject: "RE: Hone - AP Schedule", clean_text: "Please see attached quotation." })], applianceItems);
  assert.deepEqual(result.filter((item) => item.selected).map((item) => item.id), ["oven", "cooktop"]);
  assert.equal(result.some((item) => item.id === "install"), false, "trade-package references must not become direct costs");
});

test("an exact FF&E item code selects only the referenced item", () => {
  const result = matchQuoteItems([email({ subject: "Quote for Hone AP-01", clean_text: "Pricing attached." })], applianceItems);
  assert.deepEqual(result.filter((item) => item.selected).map((item) => item.id), ["oven"]);
});

test("only auto-links when project, contact, intent and line evidence are all unambiguous", () => {
  const cautious = buildQuoteThreadMatch({ emails: [email()], projects: [hone, otherProject], contacts: [poolContact], lines: poolLines });
  assert.equal(cautious.canAutoLink, true, "temporary fencing is not a candidate for a permanent glass-fence request");
  const certain = buildQuoteThreadMatch({ emails: [email()], projects: [hone, otherProject], contacts: [poolContact], lines: poolLines.slice(0, 2) });
  assert.equal(certain.canAutoLink, true);
  assert.deepEqual(certain.lines.filter((line) => line.selected).map((line) => line.id).sort(), ["footing", "glass"]);
});

test("a missing Address Book entry can never auto-link", () => {
  const result = buildQuoteThreadMatch({ emails: [email()], projects: [hone], contacts: [], lines: poolLines.slice(0, 2) });
  assert.equal(result.externalEmail, "adelaidepoolglass@mail.com");
  assert.equal(result.contact, null);
  assert.equal(result.canAutoLink, false);
});
