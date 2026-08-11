export interface PendingConversationCallEnd {
  ownerProfileId: string;
  conversationId: string;
  callId: string;
  createdAt: string;
  voiceMetrics: unknown;
}

type CallEndStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const STORAGE_KEY_PREFIX = "reslu-conversation-call-ends:v1:";
const MAX_PENDING_CALL_ENDS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function browserStorage(): CallEndStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storageKey(ownerProfileId: string) {
  return `${STORAGE_KEY_PREFIX}${ownerProfileId}`;
}

function isPendingCallEnd(value: unknown, ownerProfileId: string): value is PendingConversationCallEnd {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<PendingConversationCallEnd>;
  return entry.ownerProfileId === ownerProfileId
    && typeof entry.conversationId === "string"
    && UUID_PATTERN.test(entry.conversationId)
    && typeof entry.callId === "string"
    && UUID_PATTERN.test(entry.callId)
    && typeof entry.createdAt === "string"
    && Number.isFinite(Date.parse(entry.createdAt));
}

export function listPendingConversationCallEnds(
  ownerProfileId: string,
  storage: CallEndStorage | null = browserStorage()
): PendingConversationCallEnd[] {
  if (!storage || !UUID_PATTERN.test(ownerProfileId)) return [];
  try {
    const decoded = JSON.parse(storage.getItem(storageKey(ownerProfileId)) ?? "[]") as unknown;
    if (!Array.isArray(decoded)) return [];
    return decoded
      .filter((entry): entry is PendingConversationCallEnd => isPendingCallEnd(entry, ownerProfileId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  } catch {
    return [];
  }
}

export function savePendingConversationCallEnd(
  entry: PendingConversationCallEnd,
  storage: CallEndStorage | null = browserStorage()
) {
  if (!storage) throw new Error("Device call-record storage is unavailable");
  if (!isPendingCallEnd(entry, entry.ownerProfileId) || !UUID_PATTERN.test(entry.ownerProfileId)) {
    throw new Error("Invalid pending call end");
  }
  const pending = listPendingConversationCallEnds(entry.ownerProfileId, storage)
    .filter((candidate) => candidate.callId !== entry.callId);
  if (pending.length >= MAX_PENDING_CALL_ENDS) {
    throw new Error("Too many call records are waiting to sync");
  }
  pending.push(entry);
  pending.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  storage.setItem(storageKey(entry.ownerProfileId), JSON.stringify(pending));
}

export function removePendingConversationCallEnd(
  ownerProfileId: string,
  callId: string,
  storage: CallEndStorage | null = browserStorage()
) {
  if (!storage || !UUID_PATTERN.test(ownerProfileId) || !UUID_PATTERN.test(callId)) return;
  const next = listPendingConversationCallEnds(ownerProfileId, storage)
    .filter((entry) => entry.callId !== callId);
  if (next.length === 0) storage.removeItem(storageKey(ownerProfileId));
  else storage.setItem(storageKey(ownerProfileId), JSON.stringify(next));
}
