import type { AgentSlug, ConversationAttachment } from "@/types/conversations";

export type ConversationOutboxStatus = "queued" | "sending" | "failed";

export interface PendingConversationMessage {
  clientMessageId: string;
  ownerProfileId: string;
  conversationId: string;
  body: string;
  source: "text" | "voice" | "voice_note";
  targetAgent?: AgentSlug;
  replyToId: string | null;
  attachmentIds: string[];
  attachments: ConversationAttachment[];
  createdAt: string;
  status: ConversationOutboxStatus;
  error: string | null;
  retryable: boolean;
}

export interface ConversationTextDraft {
  ownerProfileId: string;
  conversationId: string;
  body: string;
  updatedAt: string;
}

const DATABASE_NAME = "reslu-conversation-messaging";
const DATABASE_VERSION = 1;
const OUTBOX_STORE = "message-outbox";
const DRAFT_KEY_PREFIX = "reslu-conversation-draft:v1:";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Offline message storage is unavailable in this browser."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
        const outbox = database.createObjectStore(OUTBOX_STORE, { keyPath: "clientMessageId" });
        outbox.createIndex("ownerProfileId", "ownerProfileId", { unique: false });
        outbox.createIndex("conversationId", "conversationId", { unique: false });
        outbox.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline message storage."));
  });
}

async function withObjectStore<T>(
  storeName: typeof OUTBOX_STORE,
  mode: IDBTransactionMode,
  createRequest: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = createRequest(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("Offline message storage request failed."));
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline message storage failed."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline message storage was interrupted."));
    };
  });
}

function browserLocalStorage(): Storage {
  if (typeof localStorage === "undefined") throw new Error("Draft storage is unavailable in this browser.");
  return localStorage;
}

export function recoverPendingConversationMessage(entry: PendingConversationMessage): PendingConversationMessage {
  const normalized = entry.replyToId === undefined ? { ...entry, replyToId: null } : entry;
  if (normalized.status !== "sending") return normalized;
  return { ...normalized, status: "queued", error: null, retryable: true };
}

export function sortPendingConversationMessages(entries: PendingConversationMessage[]): PendingConversationMessage[] {
  return [...entries].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function mergePendingConversationMessages(
  ...collections: PendingConversationMessage[][]
): PendingConversationMessage[] {
  const byClientMessageId = new Map<string, PendingConversationMessage>();
  for (const entries of collections) {
    for (const entry of entries) byClientMessageId.set(entry.clientMessageId, entry);
  }
  return sortPendingConversationMessages([...byClientMessageId.values()]);
}

export async function savePendingConversationMessage(entry: PendingConversationMessage): Promise<void> {
  await withObjectStore<IDBValidKey>(OUTBOX_STORE, "readwrite", (store) => store.put(entry));
}

export async function listPendingConversationMessages(): Promise<PendingConversationMessage[]> {
  const entries = await withObjectStore<PendingConversationMessage[]>(
    OUTBOX_STORE,
    "readonly",
    (store) => store.getAll() as IDBRequest<PendingConversationMessage[]>
  );
  return sortPendingConversationMessages(entries);
}

export async function removePendingConversationMessage(clientMessageId: string): Promise<void> {
  await withObjectStore<undefined>(OUTBOX_STORE, "readwrite", (store) => store.delete(clientMessageId));
}

export async function listConversationDrafts(ownerProfileId: string): Promise<ConversationTextDraft[]> {
  const storage = browserLocalStorage();
  const drafts: ConversationTextDraft[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_KEY_PREFIX)) continue;
    try {
      const value = JSON.parse(storage.getItem(key) ?? "null") as ConversationTextDraft | null;
      if (value?.ownerProfileId === ownerProfileId && value.conversationId && typeof value.body === "string") drafts.push(value);
    } catch {
      storage.removeItem(key);
    }
  }
  return drafts;
}

export async function saveConversationDraft(ownerProfileId: string, conversationId: string, body: string): Promise<void> {
  if (!body) return removeConversationDraft(ownerProfileId, conversationId);
  const draft: ConversationTextDraft = { ownerProfileId, conversationId, body, updatedAt: new Date().toISOString() };
  browserLocalStorage().setItem(`${DRAFT_KEY_PREFIX}${ownerProfileId}:${conversationId}`, JSON.stringify(draft));
}

export async function removeConversationDraft(ownerProfileId: string, conversationId: string): Promise<void> {
  browserLocalStorage().removeItem(`${DRAFT_KEY_PREFIX}${ownerProfileId}:${conversationId}`);
}
