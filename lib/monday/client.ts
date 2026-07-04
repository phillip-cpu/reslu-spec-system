/**
 * Monday.com GraphQL client — low-level transport only.
 *
 * SECURITY (non-negotiable, BUILD-SPEC.md §Security / Review §2.1):
 * every call site passes `variables` separately from `query`. Nothing
 * in this file (or lib/monday/sync.ts) ever interpolates a user-
 * supplied value (item name, supplier, note text, column id, etc.)
 * into a GraphQL query string. Column ids and board ids come from
 * project settings / env, but even those travel as variables — never
 * string-built — so there is exactly one code path and it is safe by
 * construction.
 *
 * Token: process.env.MONDAY_API_TOKEN. When unset, callers should use
 * isMondayConfigured() to short-circuit with a clean no-op rather than
 * calling mondayGraphql() at all.
 */

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2024-01";

export class MondayApiError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "MondayApiError";
  }
}

export function isMondayConfigured(): boolean {
  return Boolean(process.env.MONDAY_API_TOKEN);
}

/**
 * Executes a GraphQL request against Monday's API. `query` must be a
 * static string literal at every call site — all dynamic data belongs
 * in `variables`. Throws MondayApiError on transport or GraphQL errors;
 * callers are expected to catch and treat failure as best-effort.
 */
export async function mondayGraphql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown>
): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new MondayApiError("MONDAY_API_TOKEN is not configured");
  }

  const res = await fetch(MONDAY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": MONDAY_API_VERSION,
    },
    // `query` is always a fixed string; `variables` carries every piece
    // of dynamic/user-supplied data. Never build `query` with template
    // interpolation of external input.
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });

  let json: { data?: T; errors?: { message: string }[] };
  try {
    json = await res.json();
  } catch {
    throw new MondayApiError(`Monday API returned non-JSON response (${res.status})`);
  }

  if (json.errors?.length) {
    throw new MondayApiError(
      json.errors.map((e) => e.message).join("; "),
      json.errors
    );
  }
  if (!res.ok) {
    throw new MondayApiError(`Monday API error (${res.status})`);
  }
  return json.data as T;
}
