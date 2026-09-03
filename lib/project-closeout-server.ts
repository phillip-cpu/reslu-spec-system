import type { SupabaseClient } from "@supabase/supabase-js";
import { buildProjectCloseoutReadiness } from "@/lib/project-closeout";
import type { ProjectCloseoutCounts } from "@/types/project-closeout";

type JoinedProject = { project_id: string } | { project_id: string }[] | null;

export async function loadProjectCloseoutReadiness(
  supabase: SupabaseClient,
  projectId: string
) {
  const results = await Promise.all([
    supabase.from("board_columns").select("id,name").eq("project_id", projectId),
    supabase.from("board_groups").select("id,name").eq("project_id", projectId),
    supabase
      .from("board_tasks")
      .select("id,column_id,phase_group_id")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("items")
      .select("id,status,cost_scope")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("invoices")
      .select("id,status,payment_status")
      .eq("project_id", projectId),
    supabase
      .from("client_invoices")
      .select("id,status")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("variations")
      .select("id,status")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("signature_requests")
      .select("id,status")
      .eq("project_id", projectId),
    supabase
      .from("project_files")
      .select("id,kind,share_to_portal,in_handover_pack")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .or("kind.eq.certificate,share_to_portal.eq.true"),
    supabase
      .from("item_files")
      .select("id,kind,in_handover_pack,items!inner(project_id)")
      .in("kind", ["install_manual", "warranty"])
      .eq("items.project_id", projectId),
    supabase
      .from("site_photos")
      .select("id,in_handover_pack")
      .eq("project_id", projectId)
      .is("deleted_at", null),
  ]);

  const readError = results.find((result) => result.error)?.error;
  if (readError) throw new Error(readError.message);

  const [
    columnsResult,
    groupsResult,
    tasksResult,
    itemsResult,
    supplierInvoicesResult,
    clientInvoicesResult,
    variationsResult,
    signaturesResult,
    projectFilesResult,
    itemFilesResult,
    photosResult,
  ] = results;

  const columns = columnsResult.data ?? [];
  const groups = groupsResult.data ?? [];
  const tasks = tasksResult.data ?? [];
  const items = (itemsResult.data ?? []).filter(
    (item) => item.cost_scope !== "trade_package"
  );
  const supplierInvoices = supplierInvoicesResult.data ?? [];
  const clientInvoices = clientInvoicesResult.data ?? [];
  const variations = variationsResult.data ?? [];
  const signatures = signaturesResult.data ?? [];
  const projectFiles = projectFilesResult.data ?? [];
  const itemFiles = (itemFilesResult.data ?? []).filter((file) => {
    const joined = file.items as JoinedProject;
    const project = Array.isArray(joined) ? joined[0] : joined;
    return project?.project_id === projectId;
  });
  const photos = photosResult.data ?? [];

  const doneColumnIds = new Set(
    columns
      .filter((column) => /^(done|complete|completed)$/i.test(column.name.trim()))
      .map((column) => column.id)
  );
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const handoverTasks = tasks.filter((task) =>
    /handover|close.?out|practical completion/i.test(
      groupsById.get(task.phase_group_id)?.name ?? ""
    )
  );
  const selectedProjectFiles = projectFiles.filter((file) => file.in_handover_pack);
  const selectedItemFiles = itemFiles.filter((file) => file.in_handover_pack);
  const selectedPhotos = photos.filter((photo) => photo.in_handover_pack);

  const counts: ProjectCloseoutCounts = {
    open_work_tasks: tasks.filter((task) => !doneColumnIds.has(task.column_id)).length,
    open_handover_tasks: handoverTasks.filter(
      (task) => !doneColumnIds.has(task.column_id)
    ).length,
    handover_task_total: handoverTasks.length,
    ffe_not_installed: items.filter((item) => item.status !== "Installed").length,
    ffe_total: items.length,
    supplier_needs_matching: supplierInvoices.filter((invoice) =>
      ["unmatched", "proposed"].includes(invoice.status)
    ).length,
    supplier_approved_unpaid: supplierInvoices.filter(
      (invoice) =>
        invoice.status === "approved" && invoice.payment_status !== "paid"
    ).length,
    client_invoice_drafts: clientInvoices.filter(
      (invoice) => invoice.status === "draft"
    ).length,
    client_invoices_unpaid: clientInvoices.filter(
      (invoice) => invoice.status === "sent"
    ).length,
    proposed_variations: variations.filter(
      (variation) => variation.status === "proposed"
    ).length,
    pending_signatures: signatures.filter(
      (signature) => signature.status === "pending"
    ).length,
    handover_candidates: projectFiles.length + itemFiles.length + photos.length,
    handover_selected:
      selectedProjectFiles.length + selectedItemFiles.length + selectedPhotos.length,
    compliance_certificates_selected: selectedProjectFiles.filter(
      (file) => file.kind === "certificate"
    ).length,
    manuals_warranties_selected: selectedItemFiles.length,
    gallery_candidates: photos.length,
    gallery_selected: selectedPhotos.length,
  };

  return buildProjectCloseoutReadiness({ projectId, counts });
}
