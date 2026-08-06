/**
 * Suggests the next version label given existing labels for a project.
 * Labels stay editable, but the save control never starts inert or asks
 * the user to manually discover the next number.
 */
export function suggestNextLabel(
  existingLabels: string[],
  kind: "issue" | "vm" = "issue"
): string {
  let maxN = 0;
  for (const label of existingLabels) {
    const match = /^(?:VM_)?V(\d+)$/i.exec(label.trim());
    if (match) maxN = Math.max(maxN, Number(match[1]));
  }
  const n = maxN + 1;
  return kind === "vm" ? `VM_V${n}` : `V${n}`;
}
