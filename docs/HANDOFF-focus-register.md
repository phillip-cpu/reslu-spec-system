# Handoff — My Work focus deep-link wiring for SpecRegister.tsx

**Status:** The focus-deep-link mechanism itself (FocusOnLoad.tsx,
ScrollMemory.tsx's skip-on-focus edit, the `?focus=<kind>-<id>` hrefs in
`app/api/my-work/route.ts`) is fully built and live for board tasks,
office tasks, diary drafts, trade proposals, and design tasks. The
Spec Register's own item rows are NOT done — this file is the exact
wiring instructions for whoever next touches
`components/items/SpecRegister.tsx`.

## Why this is a handoff and not just done

`SpecRegister.tsx` is a protected file for this round (explicitly
listed DO-NOT-TOUCH), same file-boundary convention every phase of this
codebase has used — see `docs/HANDOFF-item-qty-links.md`'s identical
reasoning for the same file last round.

## Interim decision taken this round

My Work's `decision_overdue` source (items past `decision_needed_by`,
still awaiting a client decision) is the one item-linked My Work kind.
Its href, built in `app/api/my-work/route.ts`, currently points at:

```
/projects/${i.project_id}?tab=ffe&focus=decision_overdue-${i.id}
```

Rather than target a SpecRegister row (protected), it targets the
**Pricing & Procurement view** (`components/items/ProcurementView.tsx`,
NOT protected) instead — that file's item row already got
`id={`focus-decision_overdue-${item.id}`}` added this round (its `<tr>`
root, ~line 417). `components/items/ProjectWorkspace.tsx` (also not
protected) was extended with an `initialView` prop so the FF&E tab
opens straight into the Procurement sub-view when the focus param
starts with `decision_overdue-` — otherwise the view still defaults to
"Spec" and the Procurement row (and its id) would never mount, and
FocusOnLoad would find nothing. `app/(dashboard)/projects/[id]/page.tsx`
computes `initialFfeView` from `searchParams.focus` server-side and
passes it down.

**This is explicitly an interim decision**, not a permanent one — the
Spec Register (the client-facing/primary item view) is the more natural
long-term target for an "awaiting decision" deep link, since it's what
most team members actually work in day to day, and Pricing & Procurement
is an internal-only pricing lens. Once SpecRegister.tsx is out of any
concurrent task's protected boundary, whoever picks this up should
decide whether to:
  (a) add the id to SpecRegister's own row AND keep the Procurement one
      (both views can carry the same id safely as long as only one is
      mounted/visible at a time — same reasoning ProjectBoard.tsx's
      kanban vs grouped-list views already rely on), or
  (b) move the id to SpecRegister exclusively and change the href back
      to `?tab=ffe` (dropping the ProcurementView interim `initialView`
      logic in ProjectWorkspace.tsx and the matching id in
      ProcurementView.tsx).

## Exact wiring for option (a) or a Spec-Register-only follow-up

`SpecRegister.tsx`'s `ItemRow` (~line 500, root `<tr>` ~line 548) is
currently a fragment (`<>...</>`, ~line 547) since an optional expanded
detail second `<tr>` follows (~line 659). Add:

```tsx
<tr id={`focus-decision_overdue-${item.id}`} className={clsx("border-b border-[#e5e0d6] align-top", selected && "bg-sand/10")}>
```

No other changes needed in that file — `key={item.id}` is already
applied at the call site (~line 459), separate from the row's own
attributes, so adding `id` alongside `className` is a single-line,
additive, and does not touch this round's `key`/selection logic.

If the href is changed to point only at the Spec view (option b),
revert `app/api/my-work/route.ts`'s `decision_overdue` href back to
`/projects/${i.project_id}?tab=ffe&focus=decision_overdue-${i.id}`
(unchanged — the `?tab=ffe` half doesn't need to change either way)
and remove the `initialView`/`initialFfeView` plumbing added this round
in `ProjectWorkspace.tsx` / `app/(dashboard)/projects/[id]/page.tsx` if
the Procurement-view id is dropped entirely.
