export function normalizeAgentTaskArtifactContent(
  content: Record<string, unknown>,
  depth = 0
): Record<string, unknown> {
  if (depth > 3) return content;
  const embedded = typeof content.text === "string" ? content.text.trim() : null;
  if (embedded?.startsWith("{")) {
    try {
      const parsed = JSON.parse(embedded) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return normalizeAgentTaskArtifactContent(parsed as Record<string, unknown>, depth + 1);
      }
    } catch {
      // A normal text artifact may begin with a brace; show it unchanged.
    }
  }
  const artifact = content.artifact;
  if (artifact && typeof artifact === "object" && !Array.isArray(artifact)) {
    const nested = (artifact as Record<string, unknown>).content;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return normalizeAgentTaskArtifactContent(nested as Record<string, unknown>, depth + 1);
    }
  }
  return content;
}

export function agentTaskArtifactText(content: Record<string, unknown>) {
  const normalized = normalizeAgentTaskArtifactContent(content);
  const body = typeof normalized.body === "string" ? normalized.body : null;
  const text = typeof normalized.text === "string" ? normalized.text : null;
  const message = typeof normalized.message === "string" ? normalized.message : null;
  const summary = typeof normalized.summary === "string" ? normalized.summary : null;
  return body ?? text ?? message ?? summary ?? "Draft details are not available yet.";
}
