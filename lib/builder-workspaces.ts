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
 const own = items.filter(i => i.selection_scope === scope && scope !== 'shared' && scope !== 'shared_internal');
 const overrides = new Set(own.map(i => i.selection_key?.trim()).filter(Boolean));
 const shared = items.filter(i => (!i.selection_scope || i.selection_scope === 'shared' || i.selection_scope === 'shared_internal') && (!i.selection_key || !overrides.has(i.selection_key.trim())));
 return scope === 'shared' ? shared : [...shared, ...own];
}

/** Preliminary evidence only; never a costable item quantity. Null means unknown. */
export interface CandidateAllocation {
 room: string;
 room_id?: string;
 lot_key?: string;
 quantity_basis?: 'plan_count' | 'preliminary_schedule' | 'measured_area' | 'unconfirmed';
 source_reference?: string;
 source_revision?: string;
 note?: string;
 quantity: number | null;
 unit: string | null;
 lot_basis: 'per_lot' | 'project_total' | 'unknown';
 status: 'preliminary';
}
export function parseCandidateAllocations(value: unknown): CandidateAllocation[] {
 if (!Array.isArray(value) || value.length > 100) throw new Error('Provide up to 100 preliminary allocations');
 return value.map(row => {
  if (!row || typeof row !== 'object') throw new Error('Invalid allocation');
  const r = row as Record<string, unknown>;
  if (typeof r.room !== 'string' || !r.room.trim() || r.room.trim().length > 120 ||
      (r.room_id !== undefined && (typeof r.room_id !== 'string' || !r.room_id || r.room_id.length > 120)) ||
      !(r.quantity === null || (typeof r.quantity === 'number' && Number.isFinite(r.quantity) && r.quantity >= 0)) ||
      !(r.unit === null || (typeof r.unit === 'string' && !!r.unit.trim() && r.unit.trim().length <= 24)) ||
      !['per_lot', 'project_total', 'unknown'].includes(r.lot_basis as string) || r.status !== 'preliminary' ||
      (r.quantity !== null && (!r.unit || r.lot_basis === 'unknown'))) {
   throw new Error('Allocations need a room, preliminary status, and a quantity or null; known quantities need a unit and lot basis');
  }
  for (const key of ['source_reference','source_revision','note'] as const) {
   if (r[key] !== undefined && (typeof r[key] !== 'string' || r[key].length > 1000)) throw new Error('Source notes must be text up to 1000 characters');
  }
  if(r.lot_key !== undefined && (typeof r.lot_key !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(r.lot_key)))throw new Error('Invalid allocation lot');
  if(r.quantity_basis !== undefined && !['plan_count','preliminary_schedule','measured_area','unconfirmed'].includes(r.quantity_basis as string))throw new Error('Invalid quantity basis');
  return {...Object.fromEntries(['lot_key','quantity_basis','source_reference','source_revision','note'].filter(k=>r[k]!==undefined).map(k=>[k,r[k]])),room:r.room.trim(), ...(r.room_id ? {room_id:r.room_id as string} : {}), quantity:r.quantity as number|null, unit:typeof r.unit === 'string'?r.unit.trim():null, lot_basis:r.lot_basis as CandidateAllocation['lot_basis'], status:'preliminary'};
 });
}
/** Explicit lot evidence never becomes a count for a different lot. No multiplication. */
export function candidateAllocationsForScope(allocations:CandidateAllocation[]|undefined, scope:string) {
 return (allocations??[]).filter(a=>scope==='all' || !a.lot_key || a.lot_key===scope);
}
export function resolveCandidateRoomNames(allocations:CandidateAllocation[]|undefined, rooms:{id:string;name:string}[]):CandidateAllocation[]|undefined {
 return allocations?.map(a=>({...a,room:rooms.find(r=>r.id===a.room_id)?.name??a.room}));
}
export function candidateRooms(candidate: Pick<LibraryCandidate, 'preliminary_allocations'>) {
 return (candidate.preliminary_allocations ?? []).map(a => ({id:a.room_id ?? `candidate-room:${a.room.toLowerCase()}`,name:a.room}));
}
export interface LibraryCandidate {id:string;library_item_id:string;selection_scope:string;selection_key:string|null;preliminary_allocations?:CandidateAllocation[]}
export function patchCandidate(candidate:LibraryCandidate, patch:Record<string,unknown>):LibraryCandidate {
 return {...candidate,
  ...(patch.selection_scope !== undefined ? {selection_scope:patch.selection_scope as string}:{}),
  ...(patch.selection_key !== undefined ? {selection_key:typeof patch.selection_key === 'string'?patch.selection_key.trim()||null:null}:{}),
  ...(patch.preliminary_allocations !== undefined ? {preliminary_allocations:parseCandidateAllocations(patch.preliminary_allocations)}:{})};
}
function readAllocations(row:LibraryCandidate):Pick<LibraryCandidate,'preliminary_allocations'> {
 if(row.preliminary_allocations === undefined)return {};
 try{return {preliminary_allocations:parseCandidateAllocations(row.preliminary_allocations)}}catch{return {}}
}
export function projectCandidates(settings:unknown):LibraryCandidate[] {
 const rows=(settings as {builder_workspace?:{candidates?:unknown}}|null)?.builder_workspace?.candidates;
 if(!Array.isArray(rows))return [];
 return rows.filter((r):r is LibraryCandidate=>!!r&&typeof r.id==='string'&&typeof r.library_item_id==='string'&&typeof r.selection_scope==='string').map(r=>({id:r.id,library_item_id:r.library_item_id,selection_scope:r.selection_scope,selection_key:typeof r.selection_key==='string'?r.selection_key:null,...readAllocations(r)}));
}
export function withProjectCandidates(settings:Record<string,unknown>|null,candidates:LibraryCandidate[]):Record<string,unknown>&{builder_workspace:Record<string,unknown>&{candidates:LibraryCandidate[]}} {
 const current=settings??{};
 const workspace=(current.builder_workspace??{}) as Record<string,unknown>;
 // Merge against stored rows to retain source provenance and future metadata on edits.
 const stored=Array.isArray(workspace.candidates)?workspace.candidates:[];
 const preserved=candidates.map(c=>({...stored.find(r=>r && typeof r === 'object' && r.id===c.id),...c}));
 return {...current,builder_workspace:{...workspace,candidates:preserved}};
}
