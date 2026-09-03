import type {
  ProjectCloseoutArea,
  ProjectCloseoutCounts,
  ProjectCloseoutReadiness,
} from "@/types/project-closeout";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function buildProjectCloseoutReadiness(input: {
  projectId: string;
  counts: ProjectCloseoutCounts;
  generatedAt?: string;
}): ProjectCloseoutReadiness {
  const { projectId, counts } = input;
  const workAttention =
    counts.open_work_tasks +
    (counts.handover_task_total === 0 ? 1 : 0);
  const procurementAttention = counts.ffe_not_installed;
  const supplierAttention =
    counts.supplier_needs_matching + counts.supplier_approved_unpaid;
  const clientAttention =
    counts.client_invoice_drafts +
    counts.client_invoices_unpaid +
    counts.proposed_variations +
    counts.pending_signatures;
  const handoverAttention =
    counts.handover_candidates === 0 || counts.handover_selected === 0 ? 1 : 0;

  const areas: ProjectCloseoutArea[] = [
    {
      key: "work",
      label: "Work & defects",
      state: workAttention > 0 ? "attention" : "clear",
      summary:
        counts.open_work_tasks > 0
          ? `${plural(counts.open_work_tasks, "Work item")} still open.`
          : "All Work items are complete.",
      detail:
        counts.handover_task_total === 0
          ? "The Handover phase has no tasks, so practical completion and handover work is not yet defined."
          : counts.open_handover_tasks > 0
            ? `${plural(counts.open_handover_tasks, "Handover task")} still open.`
            : "The Handover phase is complete.",
      href: `/projects/${projectId}/board`,
      action: "Open Work",
      outstanding_items: workAttention,
    },
    {
      key: "procurement",
      label: "FF&E installation",
      state: procurementAttention > 0 ? "attention" : "clear",
      summary:
        counts.ffe_total === 0
          ? "No direct FF&E items are recorded."
          : counts.ffe_not_installed > 0
            ? `${plural(counts.ffe_not_installed, "FF&E item")} not marked Installed.`
            : "Every FF&E item is marked Installed.",
      detail:
        counts.ffe_total === 0
          ? "Nothing is required from the FF&E schedule for this job."
          : `${counts.ffe_total - counts.ffe_not_installed} of ${counts.ffe_total} items are installed.`,
      href: `/projects/${projectId}?tab=ffe&view=procurement`,
      action: "Open FF&E",
      outstanding_items: procurementAttention,
    },
    {
      key: "supplier_finance",
      label: "Supplier costs",
      state: supplierAttention > 0 ? "attention" : "clear",
      summary:
        supplierAttention > 0
          ? `${plural(supplierAttention, "supplier invoice")} ${supplierAttention === 1 ? "needs" : "need"} attention.`
          : "Supplier invoices are reconciled.",
      detail: `${plural(counts.supplier_needs_matching, "invoice")} unmatched or proposed; ${plural(
        counts.supplier_approved_unpaid,
        "approved invoice"
      )} not fully paid.`,
      href: `/projects/${projectId}/invoices`,
      action: "Open supplier invoices",
      outstanding_items: supplierAttention,
    },
    {
      key: "client_account",
      label: "Client account",
      state: clientAttention > 0 ? "attention" : "clear",
      summary:
        clientAttention > 0
          ? `${plural(clientAttention, "client or contract item")} ${clientAttention === 1 ? "needs" : "need"} attention.`
          : "Client billing, variations and signatures are clear.",
      detail: `${plural(counts.client_invoice_drafts, "draft invoice")}; ${plural(
        counts.client_invoices_unpaid,
        "sent invoice"
      )} unpaid; ${plural(counts.proposed_variations, "proposed variation")}; ${plural(
        counts.pending_signatures,
        "signature request"
      )} pending.`,
      href: `/projects/${projectId}/finance`,
      action: "Open Finance",
      outstanding_items: clientAttention,
    },
    {
      key: "handover_pack",
      label: "Client handover",
      state: handoverAttention > 0 ? "attention" : "clear",
      summary:
        counts.handover_selected > 0
          ? `${plural(counts.handover_selected, "file or photo")} selected for handover.`
          : "Nothing is selected for the client handover pack.",
      detail: `${counts.handover_selected} of ${counts.handover_candidates} candidates selected, including ${plural(
        counts.compliance_certificates_selected,
        "compliance certificate"
      )}, ${plural(counts.manuals_warranties_selected, "manual or warranty", "manuals or warranties")} and ${plural(
        counts.gallery_selected,
        "final photo"
      )}.`,
      href: `/projects/${projectId}/client?tab=handover`,
      action: "Curate handover",
      outstanding_items: handoverAttention,
    },
  ];

  const attentionAreaCount = areas.filter((area) => area.state === "attention").length;
  return {
    project_id: projectId,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    ready: attentionAreaCount === 0,
    clear_area_count: areas.length - attentionAreaCount,
    attention_area_count: attentionAreaCount,
    outstanding_item_count: areas.reduce(
      (total, area) => total + area.outstanding_items,
      0
    ),
    counts,
    areas,
  };
}
