import { mondayGraphql, isMondayConfigured, MondayApiError } from "./client";
import type { Item } from "@/types";

/**
 * Monday.com one-way procurement sync (BUILD-SPEC.md §Everything else:
 * "Monday one-way sync on status→Ordered"; Week 4 task).
 *
 * All GraphQL calls go through lib/monday/client.ts's mondayGraphql(),
 * which takes `variables` only — see that file's header for the
 * security rationale. Nothing here ever builds a query string with
 * item/project data.
 *
 * The app's own database remains the source of truth (BUILD-SPEC.md
 * "Roadmap note — Monday.com replacement"): this module only ever
 * pushes app -> Monday, and no code here reads Monday state back into
 * the app.
 */

export interface SyncResult {
  skipped?: string;
  mondayItemId?: string;
  error?: string;
}

export interface MondayBoard {
  id: string;
  name: string;
}

/**
 * The subset of a project's `settings` JSON used to configure the
 * Monday column mapping per-board (BUILD-SPEC.md Week 4 task: "make
 * column IDs configurable via project settings JSON field if one
 * exists, else document defaults").
 *
 * Column IDs are board-specific in Monday (auto-generated on column
 * creation), so there is no universal default that works across every
 * board — a project without this configured still syncs (name +
 * whatever columns ARE configured); unconfigured columns are simply
 * omitted from column_values rather than failing the sync.
 *
 * Documented defaults (used only in the README / setup instructions,
 * NOT hard-coded here, since real boards will differ):
 *   status       -> "status"      (Monday "Status" column)
 *   supplier     -> "text"        (Monday "Text" column)
 *   quantity     -> "numbers"     (Monday "Numbers" column)
 *   product_url  -> "link"        (Monday "Link" column)
 *   ordered_at   -> "date"        (Monday "Date" column)
 *   eta          -> "date4"       (a second Monday "Date" column)
 */
export interface MondayColumnMap {
  status?: string;
  supplier?: string;
  quantity?: string;
  product_url?: string;
  ordered_at?: string;
  eta?: string;
}

export interface ProjectSettings {
  monday?: {
    columns?: MondayColumnMap;
  };
}

/**
 * Local shape for the project fields this module needs. `settings` is
 * not part of the shared `Project` type in types/index.ts (that file is
 * owned by another engineer working in this same checkout — new types
 * are defined locally per this build's file-boundary rules rather than
 * editing it). `projects.settings` is a real jsonb column added by
 * migration 006_monday_email.sql; callers query it explicitly
 * (`select("name,monday_board_id,settings")`) and Supabase's untyped
 * query result satisfies this shape structurally.
 */
export interface ProjectForSync {
  name: string;
  monday_board_id: string | null;
  settings?: ProjectSettings | null;
}

function getColumnMap(project: Pick<ProjectForSync, "settings">): MondayColumnMap {
  return project.settings?.monday?.columns ?? {};
}

/**
 * Builds the Monday `column_values` object for an item, using only the
 * columns configured in the project's settings JSON. Monday expects
 * this as a JSON *string* value inside the mutation, but that string
 * is built with JSON.stringify (safe serialisation of a plain object),
 * never template-interpolated — it is then passed as a GraphQL
 * variable, not spliced into the query.
 */
function buildColumnValues(
  item: Pick<Item, "status" | "supplier" | "quantity" | "product_url" | "ordered_at" | "eta">,
  columns: MondayColumnMap
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  if (columns.status && item.status) {
    values[columns.status] = { label: item.status };
  }
  if (columns.supplier && item.supplier) {
    values[columns.supplier] = item.supplier;
  }
  if (columns.quantity && item.quantity != null) {
    values[columns.quantity] = String(item.quantity);
  }
  if (columns.product_url && item.product_url) {
    values[columns.product_url] = { url: item.product_url, text: item.product_url };
  }
  if (columns.ordered_at && item.ordered_at) {
    values[columns.ordered_at] = { date: item.ordered_at.slice(0, 10) };
  }
  if (columns.eta && item.eta) {
    values[columns.eta] = { date: item.eta.slice(0, 10) };
  }

  return values;
}

/**
 * List the account's boards for the project→board picker. Subitem
 * boards (auto-created by Monday, named "Subitems of …") are filtered
 * out. Returns { configured:false } when no token is set.
 */
export async function listBoards(): Promise<{
  configured: boolean;
  boards: MondayBoard[];
}> {
  if (!isMondayConfigured()) return { configured: false, boards: [] };

  const data = await mondayGraphql<{ boards: MondayBoard[] }>(
    `query ($limit: Int!) { boards(limit: $limit) { id name } }`,
    { limit: 100 }
  );
  const boards = (data.boards ?? []).filter((b) => !b.name.startsWith("Subitems of "));
  return { configured: true, boards };
}

/**
 * Push a single item to its project's Monday board. Idempotent:
 * - No monday_item_id yet -> create_item with initial column_values.
 * - Existing monday_item_id -> change_multiple_column_values (update).
 *
 * Returns { skipped } (never throws) for the two "not configured"
 * cases so callers can no-op cleanly; throws MondayApiError for actual
 * API failures so the caller's try/catch can log without persisting
 * anything (per the "errors: log + write nothing" requirement).
 */
export async function syncItemToMonday(
  item: Item,
  project: ProjectForSync
): Promise<SyncResult> {
  if (!isMondayConfigured()) {
    return { skipped: "not configured" };
  }
  if (!project.monday_board_id) {
    return { skipped: "project has no monday_board_id" };
  }

  const columns = getColumnMap(project);
  const columnValues = buildColumnValues(item, columns);
  const itemName = `${item.item_code} — ${item.name}`;

  if (item.monday_item_id) {
    const query = `
      mutation ChangeColumns($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId
          item_id: $itemId
          column_values: $columnValues
        ) {
          id
        }
      }
    `;
    const variables = {
      boardId: project.monday_board_id,
      itemId: item.monday_item_id,
      columnValues: JSON.stringify(columnValues),
    };
    const data = await mondayGraphql<{ change_multiple_column_values: { id: string } }>(
      query,
      variables
    );
    return { mondayItemId: data.change_multiple_column_values?.id ?? item.monday_item_id };
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
  const variables = {
    boardId: project.monday_board_id,
    itemName,
    columnValues: JSON.stringify(columnValues),
  };
  const data = await mondayGraphql<{ create_item: { id: string } }>(query, variables);
  const mondayItemId = data.create_item?.id;
  if (!mondayItemId) {
    throw new MondayApiError("create_item returned no id");
  }
  return { mondayItemId };
}

export { MondayApiError };
