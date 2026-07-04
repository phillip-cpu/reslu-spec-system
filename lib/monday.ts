import type { Item, Project } from "@/types";

/**
 * Monday.com one-way procurement sync (BUILD-SPEC.md §Everything else:
 * "Monday one-way sync on status→Ordered").
 *
 * SECURITY (non-negotiable, BUILD-SPEC.md §Security / Review §2.1):
 * all GraphQL calls use **variables**, never string interpolation — an
 * item name with quotes/backslashes can neither break nor inject into
 * the query.
 *
 * The token is read from MONDAY_API_TOKEN and MUST be a rotated value
 * (the one in the original brief is considered compromised). When the
 * token or the project's monday_board_id is absent, every function here
 * is a no-op that returns { skipped: true } — the sync stays dormant and
 * never blocks item edits.
 */

const MONDAY_ENDPOINT = "https://api.monday.com/v2";

interface SyncResult {
  skipped: boolean;
  reason?: string;
  mondayItemId?: string;
}

async function mondayGraphql(
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(MONDAY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-01",
    },
    // variables passed separately — never interpolated into `query`.
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error(
      Array.isArray(json.errors)
        ? json.errors.map((e: { message: string }) => e.message).join("; ")
        : "Monday API error"
    );
  }
  return json.data;
}

export interface MondayBoard {
  id: string;
  name: string;
}

/**
 * List the account's boards for the project picker. Subitem boards
 * (auto-created by Monday, named "Subitems of …") are filtered out.
 * Returns { configured:false } when no token is set.
 */
export async function listBoards(): Promise<{
  configured: boolean;
  boards: MondayBoard[];
}> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { configured: false, boards: [] };

  const data = await mondayGraphql(
    token,
    `query ($limit: Int!) { boards(limit: $limit) { id name } }`,
    { limit: 100 }
  );
  const boards = ((data.boards as MondayBoard[]) ?? []).filter(
    (b) => !b.name.startsWith("Subitems of ")
  );
  return { configured: true, boards };
}

/**
 * Push an item to its project's Monday board when it becomes Ordered.
 * Idempotent: if the item already has a monday_item_id, it is skipped.
 */
export async function syncOrderedItem(
  item: Item,
  project: Pick<Project, "name" | "monday_board_id">
): Promise<SyncResult> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) return { skipped: true, reason: "No MONDAY_API_TOKEN" };
  if (!project.monday_board_id) {
    return { skipped: true, reason: "Project has no monday_board_id" };
  }
  if (item.monday_item_id) {
    return { skipped: true, reason: "Already synced", mondayItemId: item.monday_item_id };
  }

  const query = `
    mutation CreateItem($boardId: ID!, $itemName: String!, $columnValues: JSON) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
      }
    }
  `;

  // Column values are sent as a JSON *string* per Monday's API. We only
  // set the item name generically (board column ids vary per board); the
  // detail goes into an update note below. Still passed as a variable.
  const variables = {
    boardId: project.monday_board_id,
    itemName: `${item.item_code} — ${item.name}`,
    columnValues: JSON.stringify({}),
  };

  const data = await mondayGraphql(token, query, variables);
  const created = data.create_item as { id: string } | undefined;
  const mondayItemId = created?.id;

  // Best-effort detail note (also parameterised).
  if (mondayItemId) {
    const noteQuery = `
      mutation AddUpdate($itemId: ID!, $body: String!) {
        create_update(item_id: $itemId, body: $body) { id }
      }
    `;
    const noteBody = [
      `Project: ${project.name}`,
      item.supplier ? `Supplier: ${item.supplier}` : null,
      `Qty: ${item.quantity}`,
      item.eta ? `ETA: ${item.eta}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await mondayGraphql(token, noteQuery, { itemId: mondayItemId, body: noteBody });
    } catch {
      // note is non-critical
    }
  }

  return { skipped: false, mondayItemId };
}
