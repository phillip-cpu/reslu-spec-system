# Handoff — item quantity links UI (SpecRegister.tsx)

**Status:** API + derived-quantity math + the Pricing & Procurement
view are all done and live. The Spec register's own Qty cell is NOT
done — this file is the exact wiring instructions for whoever next
touches `components/items/SpecRegister.tsx`.

## Why this is a handoff and not just done

`SpecRegister.tsx` is a protected file for this round (Round B's task
explicitly listed it as DO-NOT-TOUCH, same file-boundary convention
every phase of this codebase has used — see
`docs/HANDOFF-code-editing.md`'s own header comment for the identical
pattern applied to `item_code` editing last round). Everything else
this feature needs is fully built:

- **Migration** `supabase/migrations/027_quantity_links_materials.sql`
  — `items.measurement_id` (nullable uuid, references `measurements`,
  `on delete set null`), `items.wastage_pct` (nullable numeric, 0–50
  check), `items.coverage_per_unit` (nullable numeric).
- **The math**: `lib/item-quantity.ts` — `derivedQuantity(item,
  measurement)` and `derivedQuantityNote(item, result)`. Pure,
  dependency-free, mirrors `lib/estimate.ts`'s `effectiveQty()` exactly
  (same formula, same "unlink reverts to last hand-typed value"
  behaviour).
- **The API**: `PATCH /api/items/[id]` accepts `measurement_id`,
  `wastage_pct`, `coverage_per_unit` (see that route's `EDITABLE_FIELDS`
  doc comment, Round B addition). `GET /api/items/[id]` and `GET
  /api/projects/[id]/items` both now embed the linked measurement as
  `linked_measurement: { id, label, value, unit } | null` on every item
  row (PostgREST join, same pattern
  `app/api/projects/[id]/estimate/route.ts` already uses for
  `measurement_groups(name)`).
- **The UI it DOES already work in**: `components/items/ProcurementView.tsx`
  (Pricing & Procurement view) — fully wired: a 🔗 button opens
  `components/estimate/MeasurementLinkPicker.tsx` (reused as-is, no
  fork), a linked item shows the computed quantity read-only with a
  "linked · +10%" caption, and "Unlink" reverts to a plain editable qty
  input. `components/items/ProjectWorkspace.tsx` lazy-fetches the
  project's measurements (admin-only — same admin-gated route the
  Estimate module's Areas & Measurements tab already uses) the first
  time an admin opens the Procurement view, and passes them + an
  `isAdmin` flag down.
- **What's still missing**: the plain **Spec view** (`SpecRegister.tsx`,
  the design-only register everyone on the team sees, not just admins)
  has no link/unlink affordance at all — its Qty cell is still a bare
  editable number, with no way to see or set a measurement link. Since
  measurements are admin-gated data (see below), this is a genuine
  design question for whoever picks this up, not just a copy-paste job
  — read the note under step 3 before starting.

## What already exists for you to use

- **Derive the quantity**: import from `@/lib/item-quantity`:
  ```ts
  import { derivedQuantity, derivedQuantityNote } from "@/lib/item-quantity";

  const result = derivedQuantity(item, linkedMeasurement); // { quantity, linked, rawAdjustedValue }
  const note = derivedQuantityNote(item, result); // "linked · +10%" | null
  ```
  `item` needs `{ quantity, measurement_id, wastage_pct, coverage_per_unit }`
  — every real `items` row already has all four (migration 027), even
  though the shared `Item` type in `types/index.ts` doesn't declare the
  three new columns yet (that file is ALSO protected this round — see
  `types/round-b.ts`'s header comment). `ProcurementView.tsx` handles
  this by widening the type locally:
  ```ts
  type ItemWithQtyLink = Item & {
    measurement_id?: string | null;
    wastage_pct?: number | null;
    coverage_per_unit?: number | null;
  };
  ```
  Copy this exact pattern rather than casting with `as` at every call
  site — search `ProcurementView.tsx` for `ItemWithQtyLink` to see it
  used throughout.
- **The linked measurement itself**: `GET /api/projects/[id]/items`
  (the route `SpecRegister.tsx` already calls to load its item list —
  check `ProjectWorkspace.tsx`'s initial fetch / the server component
  that feeds `initialItems`) now returns each item with a
  `linked_measurement: { id, label, value, unit } | null` field
  attached. **This is team-visible** (not admin-gated) — it's a plain
  column embed on the team-visible items route, unlike the *picker's*
  measurements list (see below). So a plain read-only "linked · 12.4 m²"
  caption can be shown in the Spec view for EVERY team member today,
  with zero new fetches, just by reading `item.linked_measurement` off
  the existing item objects.
- **The picker itself needs an admin-gated fetch**: the full list of
  measurements to choose FROM (for a "link to a measurement" picker)
  comes from `GET /api/projects/[id]/estimate/measurements/groups`,
  which 403s for non-admins (BUILD-SPEC.md treats Areas & Measurements
  as estimate-adjacent financial data). `ProcurementView.tsx`'s parent
  (`ProjectWorkspace.tsx`) only fetches this when `isAdmin` is true —
  see its `useEffect` guarded by `view !== "procurement" || !isAdmin`.
  **This is the actual design decision for whoever wires the Spec
  view**: either (a) only show the link/unlink picker to admins in the
  Spec view too (thread an `isAdmin` prop into `SpecRegister.tsx`, same
  as `ProcurementView.tsx` already does), or (b) decide the whole team
  should be able to link a measurement from the Spec view and get
  BUILD-SPEC.md sign-off on relaxing that route's admin gate first —
  do NOT quietly bypass the gate by calling the admin route from a
  non-admin-checked component; if in doubt, ship option (a), which
  matches every other Round B surface exactly.
- **The picker component**: `components/estimate/MeasurementLinkPicker.tsx`
  — generic, not cost-line-specific (only imports `MeasurementWithGroup`
  from `@/types`), already reused as-is by `ProcurementView.tsx`. Same
  props: `{ measurements, currentMeasurementId, onSelect, onClose }`.
- **Unlinking**: `onPatch({ measurement_id: null, wastage_pct: null })`
  — always clear `wastage_pct` alongside `measurement_id` on unlink
  (meaningless without a link, same convention the Estimate module's
  `MeasurementLinkPicker` callers already follow for cost lines).

## Exactly where to wire it in SpecRegister.tsx

1. **Which cell**: search for `roomQty !== null ? (` — the Qty `<td>`
   currently branches on room-grouping vs. category-grouping and
   renders a plain `EditableCell` in the category-grouping branch:
   ```tsx
   <EditableCell
     value={num(item.quantity)}
     type="number"
     align="right"
     onCommit={(v) => onPatch({ quantity: v === "" ? 1 : Number(v) })}
   />
   ```
   Wrap this exact branch the same way `ProcurementView.tsx`'s `QtyCell`
   component does: if `item.linked_measurement` is set, render the
   derived quantity + note + Unlink button instead of the editable
   input; else render the existing `EditableCell` unchanged, optionally
   with a link-icon button next to it (admin-only per the decision
   above). `ProcurementView.tsx`'s `QtyCell` function is a
   copy-adaptable template — it is NOT importable as-is (it's not
   exported, and it hard-codes the `NumCell` shape from that file), but
   the branching logic and the `onPatch` calls are exactly what's
   needed here too.

2. **Which call**: `onPatch` in this row component already PATCHes
   `PATCH /api/items/[id]` with whatever partial object it's given
   (same as every other field in this file) — `onPatch({ measurement_id: v })`
   is all a picker's `onSelect` needs to call. No new API call, no new
   prop threading beyond whatever's needed to pass `measurements`/
   `isAdmin` down from `ProjectWorkspace.tsx` (which already computes
   both — search that file for `measurements`/`isAdmin` state, both
   added this round for `ProcurementView.tsx` and directly reusable).

3. **The room-grouping branch (`roomQty !== null`) should NOT get a
   link affordance.** That branch shows a per-room quantity breakdown,
   not the item's own top-level quantity — a measurement link is a
   property of the item as a whole, so it belongs only in the
   category-grouping branch (the `else` side of that same ternary),
   exactly where the plain `EditableCell` lives today.

4. **Nothing else changes.** No new column, no new route, no new
   modal beyond reusing `MeasurementLinkPicker.tsx` in a popover (same
   `absolute` positioning trick `ProcurementView.tsx`'s `QtyCell` uses
   — search that file for `absolute right-0 top-full` for the exact
   positioning classes).

## Manual test checklist once wired

- Link an item to a measurement in the Spec view (or confirm it shows
  read-only for non-admins per whichever gating option was chosen) —
  the Qty cell should show the derived figure, not the raw
  `items.quantity` column.
- Confirm the SAME item, viewed in the Pricing & Procurement view,
  shows the identical derived quantity and "linked · +10%" caption —
  both views read the same `measurement_id`/`wastage_pct`/
  `coverage_per_unit` columns via the same `derivedQuantity()` function,
  so they must never disagree.
- Unlink from the Spec view — confirm the cell reverts to an editable
  input showing the last hand-typed `items.quantity` value (not 0, not
  blank).
- Confirm a room-grouped view of the same item still shows its
  per-room quantity breakdown unaffected by the link (the room
  allocation total is a separate concern from the item's own linked
  quantity — see the `roomQty !== null` branch note above).
