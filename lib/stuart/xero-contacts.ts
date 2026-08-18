import { getActiveXeroConnection, xeroGet } from "@/lib/xero/client";

type XeroContactRecord = Record<string, unknown>;

export interface StuartXeroContactCandidate {
  contact_id: string;
  name: string;
  status: string | null;
}

export async function searchStuartXeroContacts(query: string): Promise<{
  query: string;
  candidates: StuartXeroContactCandidate[];
}> {
  const normalized = query.trim();
  if (normalized.length < 2 || normalized.length > 100) {
    throw new Error("Xero contact search must be between 2 and 100 characters");
  }

  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  if (!connection.scopes.some((scope) => scope === "accounting.contacts.read" || scope === "accounting.contacts")) {
    throw new Error("Reconnect Xero to grant Stuart contact-read access");
  }

  const response = await xeroGet<{ Contacts?: XeroContactRecord[] }>(
    connection,
    "api.xro/2.0/Contacts",
    { searchTerm: normalized, page: "1" },
  );
  const candidates = (response.Contacts ?? [])
    .flatMap((contact): StuartXeroContactCandidate[] => {
      const contactId = typeof contact.ContactID === "string" ? contact.ContactID : "";
      const name = typeof contact.Name === "string" ? contact.Name.trim() : "";
      if (!contactId || !name) return [];
      return [{
        contact_id: contactId,
        name,
        status: typeof contact.ContactStatus === "string" ? contact.ContactStatus : null,
      }];
    })
    .slice(0, 25);

  return { query: normalized, candidates };
}
