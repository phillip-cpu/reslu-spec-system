import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedInvoiceAllocation } from "@/lib/invoice-allocations";

type SavedAllocation = {
  id: string;
  source_line_id: string | null;
  match_type: string;
  match_id: string;
};

function allocationKey(allocation: {
  source_line_id?: string | null;
  match_type: string;
  match_id: string;
}) {
  return allocation.source_line_id
    ? `source:${allocation.source_line_id}`
    : `target:${allocation.match_type}:${allocation.match_id}`;
}

/**
 * Persists optional FF&E trace links after the transactional allocation
 * setter has recreated the invoice_allocations rows. The DB trigger
 * repeats project/allowance validation. If this fails the invoice is
 * still unapproved, so the user can safely correct/retry without any
 * financial actual having been posted.
 */
export async function saveInvoiceDeliveryItemLinks(
  supabase: SupabaseClient,
  invoiceId: string,
  projectId: string,
  allocations: NormalizedInvoiceAllocation[]
): Promise<{ error: string | null }> {
  const requested = allocations.filter((allocation) => (allocation.delivery_item_ids ?? []).length > 0);
  if (requested.length === 0) return { error: null };

  const targetLineIds = [...new Set(requested.map((allocation) => allocation.match_id))];
  const itemIds = [...new Set(requested.flatMap((allocation) => allocation.delivery_item_ids ?? []))];

  const [{ data: lines, error: linesError }, { data: items, error: itemsError }] = await Promise.all([
    supabase
      .from("cost_lines")
      .select("id")
      .eq("project_id", projectId)
      .eq("line_kind", "delivery_allowance")
      .is("deleted_at", null)
      .in("id", targetLineIds),
    supabase
      .from("items")
      .select("id")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .in("id", itemIds),
  ]);
  if (linesError) return { error: linesError.message };
  if (itemsError) return { error: itemsError.message };
  if ((lines ?? []).length !== targetLineIds.length) {
    return { error: "Actual delivery must be allocated to a Delivery allowance" };
  }
  if ((items ?? []).length !== itemIds.length) {
    return { error: "A related FF&E item is not in this project" };
  }

  const { data: saved, error: savedError } = await supabase
    .from("invoice_allocations")
    .select("id,source_line_id,match_type,match_id")
    .eq("invoice_id", invoiceId);
  if (savedError) return { error: savedError.message };

  const savedByKey = new Map(
    ((saved ?? []) as SavedAllocation[]).map((allocation) => [allocationKey(allocation), allocation])
  );
  const rows: Array<{ invoice_allocation_id: string; item_id: string }> = [];
  for (const allocation of requested) {
    const savedAllocation = savedByKey.get(allocationKey(allocation));
    if (!savedAllocation) return { error: "A saved delivery allocation could not be found" };
    for (const itemId of allocation.delivery_item_ids ?? []) {
      rows.push({ invoice_allocation_id: savedAllocation.id, item_id: itemId });
    }
  }

  const { error } = await supabase.from("invoice_allocation_delivery_items").insert(rows);
  return { error: error?.message ?? null };
}
