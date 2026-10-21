export interface ScheduleItem {
 id: string; library_item_id?: string | null; selection_scope?: string; selection_key?: string | null;
}
export interface BuilderLot { key: string; label: string }
export function projectLots(settings: unknown): BuilderLot[] {
 const value = (settings as { builder_workspace?: { lots?: unknown } } | null)?.builder_workspace?.lots;
 if (!Array.isArray(value)) return [];
 return value.filter((v): v is BuilderLot => !!v && typeof v.key === 'string' && /^[a-z0-9_-]{1,64}$/.test(v.key) && v.key !== 'shared' && typeof v.label === 'string');
}
/** A lot-specific slot replaces only that slot; library IDs remain canonical. */
export function resolveLotSchedule<T extends ScheduleItem>(items: T[], scope: string): T[] {
 if (scope === 'all') return items;
 const own = items.filter(i => i.selection_scope === scope && scope !== 'shared');
 const overrides = new Set(own.map(i => i.selection_key?.trim()).filter(Boolean));
 const shared = items.filter(i => (!i.selection_scope || i.selection_scope === 'shared') && (!i.selection_key || !overrides.has(i.selection_key.trim())));
 return scope === 'shared' ? shared : [...shared, ...own];
}
