import type { SowTemplateLine, SowTemplateSection } from "@/types/phase-12a-a";

export interface GroundedSowItem {
  item_code: string;
  name: string;
  quantity: number;
  category: string;
  colour?: string | null;
  material?: string | null;
  finish?: string | null;
}

export interface GroundedRoomTemplateInput {
  roomName: string;
  items: GroundedSowItem[];
  planFilenames: string[];
}

type ScopeGroup =
  | "electrical"
  | "floor_finish"
  | "wall_tiling"
  | "joinery"
  | "stone"
  | "plumbing"
  | "painting"
  | "carpentry"
  | "external"
  | "general";

function prefixFor(item: GroundedSowItem): string {
  return (item.category || item.item_code.split("-")[0] || "").trim().toUpperCase();
}

function scopeGroupFor(item: GroundedSowItem): ScopeGroup {
  const prefix = prefixFor(item);
  const name = item.name.toLowerCase();
  if (["EL", "LI"].includes(prefix)) return "electrical";
  if (prefix === "TL") {
    return /wall|skirting|splashback/.test(name) ? "wall_tiling" : "floor_finish";
  }
  if (["LA", "CF", "HD", "AP"].includes(prefix)) return "joinery";
  if (prefix === "ST") return "stone";
  if (["SW", "TW"].includes(prefix)) return "plumbing";
  if (prefix === "PF") return "painting";
  if (["DR", "PR", "GF", "TB"].includes(prefix)) return "carpentry";
  if (["OD", "MF"].includes(prefix)) return "external";
  if (prefix === "CP") return "floor_finish";
  return "general";
}

function detailList(item: GroundedSowItem): string {
  const details: string[] = [];
  if (Number.isFinite(item.quantity) && item.quantity > 0) details.push(`qty ${item.quantity}`);
  if (item.material?.trim()) details.push(item.material.trim());
  if (item.colour?.trim()) details.push(item.colour.trim());
  if (item.finish?.trim()) details.push(item.finish.trim());
  return [...new Set(details)].join("; ");
}

function itemLabel(item: GroundedSowItem): string {
  const code = item.item_code.trim();
  const name = item.name.trim();
  const details = detailList(item);
  return `${code ? `${code} — ` : ""}${name}${details ? ` (${details})` : ""}`;
}

function itemLine(item: GroundedSowItem): SowTemplateLine {
  const value = itemLabel(item);
  const group = scopeGroupFor(item);
  const common = "in the locations shown on the plans and in accordance with the current FF&E schedule.";
  switch (group) {
    case "electrical":
      return { kind: "inclusion", text: `ELECTRICAL & LIGHTING — Install ${value} ${common}` };
    case "floor_finish":
      return { kind: "inclusion", text: `FLOOR FINISHES — Install ${value} ${common}` };
    case "wall_tiling":
      return { kind: "inclusion", text: `WALL TILING — Install ${value} ${common}` };
    case "joinery":
      return { kind: "inclusion", text: `JOINERY — Supply and install ${value} ${common}` };
    case "stone":
      return { kind: "inclusion", text: `STONE — Template, supply and install ${value} ${common}` };
    case "plumbing":
      return { kind: "inclusion", text: `SANITARYWARE & TAPWARE — Install and connect ${value} ${common}` };
    case "painting":
      return { kind: "inclusion", text: `PAINTING — Prepare the nominated substrate and apply ${value} ${common}` };
    case "carpentry":
      return { kind: "inclusion", text: `CARPENTRY — Install ${value} ${common}` };
    case "external":
      return { kind: "inclusion", text: `EXTERNAL WORKS — Install ${value} ${common}` };
    default:
      return {
        kind: "note",
        text: `FF&E REFERENCE — ${value}. Confirm supply responsibility, trade ownership and installation requirements before issue.`,
      };
  }
}

function isWetRoom(roomName: string): boolean {
  return /\b(?:bath|bathroom|ensuite|powder|laundry|wc|toilet)\b/i.test(roomName);
}

/**
 * Builds a conservative, data-grounded starter for an EMPTY room.
 * It follows the useful Laundry/Powder pattern (one clear action per
 * trade and item code) without copying their project-specific scope.
 * The explicit SCOPE CHECK remains a hard pre-issue reminder because
 * demolition, retained work and service relocations cannot be inferred
 * safely from the FF&E register alone.
 */
export function groundedRoomSectionTemplate(input: GroundedRoomTemplateInput): SowTemplateSection {
  const planRefs = [...new Set(input.planFilenames.map((name) => name.trim()).filter(Boolean))];
  const lines: SowTemplateLine[] = [
    {
      kind: "note",
      text: planRefs.length > 0
        ? `Ref: ${planRefs.join("; ")}`
        : `Ref: {{drawing references for ${input.roomName}}}`,
    },
  ];

  if (isWetRoom(input.roomName)) {
    lines.push(
      {
        kind: "inclusion",
        text: "WATERPROOFING — Full floor waterproofing including a minimum 200mm upturn to walls, waterproof all relevant penetrations, and complete the specified wet-area system in accordance with AS 3740 and the manufacturer's requirements.",
      },
      {
        kind: "inclusion",
        text: "WATERPROOFING — Allow for RESLU inspection and the required compliance documentation before finishes are installed.",
      }
    );
  }

  for (const item of [...input.items].sort((a, b) => a.item_code.localeCompare(b.item_code))) {
    lines.push(itemLine(item));
  }

  lines.push({
    kind: "note",
    text: "SCOPE CHECK — Review the current drawings and add all demolition, retained items, set-out, dimensions, service relocations, substrate preparation, making-good and other plan-only work before issue.",
  });

  return { heading: input.roomName, lines };
}
