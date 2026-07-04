/**
 * @deprecated This flat module has been superseded by lib/monday/client.ts
 * + lib/monday/sync.ts (Week 4 build — see lib/monday/sync.ts header for
 * the full rationale). It could not be deleted from this working copy
 * (filesystem denied removal), so it is kept as a thin re-export shim for
 * any stale import path. New code should import from "@/lib/monday/sync"
 * directly.
 *
 * Notable fix in the new module: this old version's syncOrderedItem()
 * sent an EMPTY column_values object ("board column ids vary per
 * board") and stuffed real data into a free-text Monday "update" note
 * instead — meaning no Monday column (status/supplier/qty/url) was
 * ever actually populated. The new sync.ts builds real column_values
 * from a per-project column-id map (project.settings.monday.columns)
 * and also supports change_multiple_column_values for re-syncing an
 * already-created item, which this version never did.
 */
export { listBoards, syncItemToMonday as syncOrderedItem } from "./monday/sync";
export type { MondayBoard } from "./monday/sync";
