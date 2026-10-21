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

export interface LibraryCandidate {id:string;library_item_id:string;selection_scope:string;selection_key:string|null}
export function projectCandidates(settings:unknown):LibraryCandidate[] {
 const rows=(settings as {builder_workspace?:{candidates?:unknown}}|null)?.builder_workspace?.candidates;
 if(!Array.isArray(rows))return [];
 return rows.filter((r):r is LibraryCandidate=>!!r&&typeof r.id==='string'&&typeof r.library_item_id==='string'&&typeof r.selection_scope==='string').map(r=>({id:r.id,library_item_id:r.library_item_id,selection_scope:r.selection_scope,selection_key:typeof r.selection_key==='string'?r.selection_key:null}));
}
export function withProjectCandidates(settings:Record<string,unknown>|null,candidates:LibraryCandidate[]):Record<string,unknown>&{builder_workspace:Record<string,unknown>&{candidates:LibraryCandidate[]}} {
 const current=settings??{};
 const workspace=(current.builder_workspace??{}) as Record<string,unknown>;
 return {...current,builder_workspace:{...workspace,candidates}};
}
