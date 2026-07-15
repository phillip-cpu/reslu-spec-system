export function validLeadMeetingStoragePath(path: string, leadId: string, userId: string): boolean {
  return path.startsWith(`lead-meetings/${leadId}/${userId}/`) && !path.includes("../");
}

export function cleanStringList(value: unknown, limit = 30): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

