const EDITABLE_PROJECT_DETAIL_FIELDS = new Set([
  "name",
  "client_name",
  "address",
  "client_email",
  "client_phone",
  "client_secondary_name",
  "client_secondary_email",
  "client_secondary_phone",
  "alias",
]);

const NULLABLE_FIELDS = new Set([
  "client_email",
  "client_phone",
  "client_secondary_name",
  "client_secondary_email",
  "client_secondary_phone",
  "alias",
]);

export function normalizeProjectDetailsUpdate(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Project update must be an object");
  }
  const projectId = typeof input.project_id === "string" ? input.project_id.trim() : "";
  const expectedUpdatedAt = typeof input.expected_updated_at === "string"
    ? input.expected_updated_at.trim()
    : "";
  if (!projectId) throw new Error("project_id is required");
  if (!expectedUpdatedAt || Number.isNaN(Date.parse(expectedUpdatedAt))) {
    throw new Error("expected_updated_at must be the exact current project updated_at timestamp");
  }

  const patch = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (["project_id", "expected_updated_at"].includes(key)) continue;
    if (!EDITABLE_PROJECT_DETAIL_FIELDS.has(key)) {
      throw new Error(`Project field ${key} is not editable through this operational tool`);
    }
    if (rawValue === null && NULLABLE_FIELDS.has(key)) {
      patch[key] = null;
      continue;
    }
    if (typeof rawValue !== "string") throw new Error(`${key} must be a string`);
    const value = rawValue.trim();
    if (!value && !NULLABLE_FIELDS.has(key)) throw new Error(`${key} cannot be empty`);
    patch[key] = value || null;
  }
  if (Object.keys(patch).length === 0) throw new Error("At least one editable project detail is required");
  return { projectId, expectedUpdatedAt, patch };
}

export function verifyProjectDetails(project, expectedPatch) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new Error("Project readback was missing");
  }
  const mismatches = Object.entries(expectedPatch)
    .filter(([key, value]) => project[key] !== value)
    .map(([key]) => key);
  if (mismatches.length > 0) {
    throw new Error(`Project readback did not match updated fields: ${mismatches.join(", ")}`);
  }
  return true;
}
