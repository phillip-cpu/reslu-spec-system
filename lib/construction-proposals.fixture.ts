import type { EstimateVersion } from "../types/phase-12a-a";
import type { SowDocument, SowSectionWithLines } from "../types";
import type { ConstructionSelection } from "../types/construction-proposals";
export function fixture() {
  const version = { id: "version-a", project_id: "synthetic-project", label: "Estimate A", snapshot: {
    markup_pct: .25, rollup: { approvedVariationsExGst: 0 },
    sections: [ { id: "a", name: "Kitchen", lines: [{ id: "line-a", description: "Cabinetry", qty: 1, rate_ex_gst: 80, cost_ex_gst: null, quoted_to_client_ex_gst: null, notes: "SECRET-SUPPLIER", actual_paid_ex_gst: 77 }] }, { id: "b", name: "Patio", lines: [{ id: "line-b", qty: 1, cost_ex_gst: 900, quoted_to_client_ex_gst: 200 }] }, { id: "c", name: "Site establishment", lines: [{ id: "line-c", cost_ex_gst: 16, quoted_to_client_ex_gst: 20 }] } ],
    measurements: [], ffe: { categories: [{ category: "Appliances", client_total: 10 }], unpriced_count: 0 }, wholeJob: { combinedExGst: 330, combinedIncGst: 363 }, sow_revision_label: "S1",
  } } as unknown as EstimateVersion;
  const sow = { id: "sow-a", project_id: "synthetic-project", revision_label: "S1", status: "issued", deleted_at: null } as SowDocument;
  const sections = [{ id: "scope-a", heading: "Renovation", lines: [{ text: "Build kitchen", kind: "inclusion" }, { text: "Council fee", kind: "exclusion" }] }, { id: "scope-b", heading: "Appliance option", lines: [{ text: "Optional appliance", kind: "inclusion" }] }] as SowSectionWithLines[];
  const selection: ConstructionSelection = { estimate_version_id: version.id, sow_id: sow.id, groups: { "section:a": "internal", "section:b": "external", "section:c": "preliminaries", "ffe:Appliances": "option" }, scope_groups: { "scope-a": "internal", "scope-b": "option" }, payments: [{ label: "Deposit", percentage: 5 }, { label: "Steel", percentage: 19 }, ...Array.from({ length: 8 }, (_, i) => ({ label: `Stage ${i+1}`, percentage: 9.5 }))] };
  return { version, sow, sections, selection, sourceDigest: "synthetic-digest" };
}
