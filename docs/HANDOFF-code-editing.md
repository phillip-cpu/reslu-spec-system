# Handoff — item code editing UI (SpecRegister.tsx)

**Status:** API is done and live. The UI is NOT done — this file is the
exact wiring instructions for whoever next touches
`components/items/SpecRegister.tsx`.

## Why this is a handoff and not just done

`SpecRegister.tsx` is a protected file for this round (the task
explicitly listed it as DO-NOT-TOUCH — same file-boundary convention
every phase of this codebase has used: see e.g. `types/phase-12a-b.ts`'s
own header comment for the general pattern of "another
agent/round owns this file, work around it"). The API side
(`PATCH /api/items/[id]` accepting `item_code`) is fully built,
validated, and documented — see `app/api/items/[id]/route.ts`'s
`EDITABLE_FIELDS` doc comment and the `item_code` handling block inside
its `PATCH` handler. Only the actual input + error display in the
register's row UI is missing, because that lives in the protected file.

## What already exists for you to use

- **The API**: `PATCH /api/items/[id]` with body `{ item_code: "TW-05" }`.
  - Normalises: trims whitespace, uppercases.
  - Validates format: `^[A-Z]{2,3}-\d{1,3}$` (2-3 letters, hyphen, 1-3
    digits) — reject client-side with the same pattern before sending,
    so the user doesn't wait on a round-trip for an obvious typo. Import
    it rather than re-typing the regex:
    ```ts
    import { ITEM_CODE_PATTERN } from "@/types/phase-small-round";
    ```
  - On success: `200 { item }` — the full updated item row, same shape
    every other `onPatch` call in this file already receives.
  - On empty value: `400 { error: "item_code cannot be empty" }`.
  - On bad format: `400 { error: "item_code must look like TW-01 (2-3 letters, hyphen, 1-3 digits)" }`.
  - **On a duplicate within the same project: `409 { error: "Item code \"TW-05\" is already used by another item in this project" }`.**
    409 is the status to branch on for "show a conflict message",
    distinct from a generic 400 validation failure.
  - Changing the code does **not** renumber any other item — see the
    "Deliberately NOT renumbering" comment directly above the update
    call in that route for the full reasoning (short version: codes are
    referenced by number in documents outside this database — PDFs
    already sent to clients, signed SOWs, supplier POs — so shifting
    other items' codes to "close the gap" would silently break
    cross-references this system has no way to go back and fix).
- **The type**: `PatchItemCodeInput` and `ITEM_CODE_PATTERN`, both
  exported from `types/phase-small-round.ts`.

## Exactly where to wire it in SpecRegister.tsx

1. **Which cell**: the item code currently renders as a plain,
   non-interactive `<td>` — find this block (search for
   `{item.item_code}`):

   ```tsx
   <td className="whitespace-nowrap px-2 py-1.5 text-body font-normal text-nearblack">
     {item.item_code}
   </td>
   ```

   Replace the `{item.item_code}` text with an `EditableCell` — the
   same inline-edit component every other cell in this row already
   uses (defined near the top of this file, search for
   `function EditableCell`). Every other editable field in this table
   (`name`, `quantity`, `brand`, `supplier`, etc. — search for
   `<EditableCell` for the full list) follows this exact shape:

   ```tsx
   <td className="whitespace-nowrap px-2 py-1.5">
     <EditableCell
       value={item.item_code}
       onCommit={(v) => v && onPatch({ item_code: v })}
     />
   </td>
   ```

   `EditableCell` already handles the click-to-edit / blur-to-commit /
   Enter-to-commit / Escape-to-cancel interaction — nothing new to build
   there. Don't uppercase/trim in the `onCommit` callback; the API does
   that server-side and returns the normalised value in the response
   (same as every other field's round-trip in this file).

2. **Which call**: `onPatch` is already the prop this component uses
   for every other field (`onPatch({ name: v })`, `onPatch({ category: e.target.value })`,
   etc. — it's the same `PATCH /api/items/[id]` call, just with a
   different key in the body). No new call path, no new prop threading
   — `onPatch({ item_code: v })` is all that's needed. Do NOT add a
   second/separate API call for this field.

3. **Error display — the one real wrinkle**: every other `EditableCell`
   commit in this file assumes success and just re-renders from the
   patched item. `item_code` is the first editable field on this row
   that can come back with a **409** (duplicate) rather than a plain
   400/500, and the existing `onPatch` plumbing (search for how `onError`
   is threaded into this component — it's a prop passed down from
   `ProjectWorkspace.tsx`) already surfaces `{ error }` messages from any
   failed PATCH into the same banner every other row-level save error
   uses. Confirm that banner text is legible for a 409 specifically
   (it will already work "for free" if `onPatch`'s existing catch
   block just forwards `body.error` to `onError` — check the row
   component's `onPatch` wrapper, e.g. how it's called around line
   ~150-200 of this file where `onPatch` is defined for the row, to
   confirm the message reaches the same place). If it does not already
   propagate the message that far, that's the one piece of new plumbing
   this task needs.

4. **Nothing else changes.** No new column, no new modal, no new route.
   Category's existing `<select>` already carries a
   `title="Changing category does not change the existing item code"`
   hint (a few lines above the item_code cell) — leave that as-is; it's
   telling the user category and code are independent, which is still
   true and still relevant once code becomes directly editable too.

## Manual test checklist once wired

- Edit a code to a valid new value (e.g. `TW-01` → `TW-09`) in a
  project with no `TW-09` — should save silently like any other field.
- Edit a code to one that already exists elsewhere in the same project
  — should show the 409 message, and the cell should revert to
  showing the old (unsaved) code, not a blank/broken state.
- Edit a code to something that doesn't match the pattern (e.g. `tw1`,
  `TOOLONGCODE-1`, `TW-1234`) — should be caught before the request
  fires if client-side validation was added per step 1 above; if not,
  confirm the 400 message from the server still displays legibly.
- Confirm editing one item's code does NOT change any other item's
  code in the same project (open the register, note two codes, change
  one, confirm the other is untouched).
- Confirm a code change does NOT reset `client_approved` on the item —
  by design, `reset_approval_on_material_change()` (migration 001)
  does not list `item_code` among the columns that trigger a reset, so
  this should already be true with no extra work; worth a quick manual
  check anyway since this is exactly the kind of silent-regression spot
  worth confirming once the UI exists.
