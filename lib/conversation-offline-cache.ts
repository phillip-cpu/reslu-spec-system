import type {
  ConversationAgentActivity,
  ConversationMessage,
  ConversationParticipant,
  ConversationsResponse,
} from "@/types/conversations";

const DATABASE_NAME = "reslu-conversation-cache";
const DATABASE_VERSION = 1;
const CONVERSATION_LIST_STORE = "conversation-lists";
const MESSAGE_STORE = "conversation-messages";
const LAST_PROFILE_KEY = "reslu-last-conversation-profile:v1";
export const MAX_CACHED_CONVERSATION_MESSAGES = 100;

export interface CachedConversationList {
  ownerProfileId: string;
  data: ConversationsResponse;
  cachedAt: string;
}

export interface CachedConversationMessages {
  key: string;
  ownerProfileId: string;
  conversationId: string;
  messages: ConversationMessage[];
  participants: ConversationParticipant[];
  agentActivity: ConversationAgentActivity[];
  pinnedMessages: ConversationMessage[];
  hasOlder: boolean;
  cachedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Offline conversation cache is unavailable in this browser."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CONVERSATION_LIST_STORE)) {
        database.createObjectStore(CONVERSATION_LIST_STORE, { keyPath: "ownerProfileId" });
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        const store = database.createObjectStore(MESSAGE_STORE, { keyPath: "key" });
        store.createIndex("ownerProfileId", "ownerProfileId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline conversation cache."));
  });
}

async function withStore<T>(
  storeName: typeof CONVERSATION_LIST_STORE | typeof MESSAGE_STORE,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error ?? new Error("Offline conversation cache request failed."));
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline conversation cache failed."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline conversation cache was interrupted."));
    };
  });
}

export function conversationMessageCacheKey(ownerProfileId: string, conversationId: string) {
  return `${ownerProfileId}:${conversationId}`;
}

export function boundedCachedConversationMessages(messages: ConversationMessage[]) {
  return messages.slice(-MAX_CACHED_CONVERSATION_MESSAGES);
}

export function rememberConversationCacheProfile(ownerProfileId: string) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(LAST_PROFILE_KEY, ownerProfileId);
}

export function lastConversationCacheProfile() {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(LAST_PROFILE_KEY);
}

export async function saveCachedConversationList(ownerProfileId: string, data: ConversationsResponse) {
  const snapshot: CachedConversationList = {
    ownerProfileId,
    data,
    cachedAt: new Date().toISOString(),
  };
  await withStore<IDBValidKey>(CONVERSATION_LIST_STORE, "readwrite", (store) => store.put(snapshot));
  rememberConversationCacheProfile(ownerProfileId);
}

export async function loadCachedConversationList(ownerProfileId: string) {
  return withStore<CachedConversationList | undefined>(
    CONVERSATION_LIST_STORE,
    "readonly",
    (store) => store.get(ownerProfileId) as IDBRequest<CachedConversationList | undefined>
  );
}

export async function saveCachedConversationMessages(snapshot: Omit<CachedConversationMessages, "key" | "messages" | "cachedAt"> & {
  messages: ConversationMessage[];
}) {
  const value: CachedConversationMessages = {
    ...snapshot,
    key: conversationMessageCacheKey(snapshot.ownerProfileId, snapshot.conversationId),
    messages: boundedCachedConversationMessages(snapshot.messages),
    cachedAt: new Date().toISOString(),
  };
  await withStore<IDBValidKey>(MESSAGE_STORE, "readwrite", (store) => store.put(value));
}

export async function loadCachedConversationMessages(ownerProfileId: string, conversationId: string) {
  return withStore<CachedConversationMessages | undefined>(
    MESSAGE_STORE,
    "readonly",
    (store) => store.get(conversationMessageCacheKey(ownerProfileId, conversationId)) as IDBRequest<CachedConversationMessages | undefined>
  );
}
