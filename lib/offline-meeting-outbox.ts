export interface PendingMeetingAudio {
  id: string;
  leadId: string;
  filename: string;
  mimeType: string;
  blob: Blob;
  recordedAt: string;
  durationSeconds: number | null;
  createdAt: string;
  storagePath?: string;
}

const DB_NAME = "reslu-offline-capture";
const STORE_NAME = "lead-meeting-audio";

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("Offline storage is unavailable in this browser."));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("leadId", "leadId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open offline storage."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    action(store, resolve, reject);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => reject(transaction.error ?? new Error("Offline storage operation failed."));
  });
}

export async function savePendingMeetingAudio(entry: PendingMeetingAudio): Promise<void> {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function queueMeetingAudio(
  input: Omit<PendingMeetingAudio, "id" | "createdAt">
): Promise<PendingMeetingAudio> {
  const entry: PendingMeetingAudio = {
    ...input,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await savePendingMeetingAudio(entry);
  return entry;
}

export async function listPendingMeetingAudio(leadId: string): Promise<PendingMeetingAudio[]> {
  return withStore<PendingMeetingAudio[]>("readonly", (store, resolve, reject) => {
    const request = store.index("leadId").getAll(IDBKeyRange.only(leadId));
    request.onsuccess = () => resolve((request.result as PendingMeetingAudio[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    request.onerror = () => reject(request.error);
  });
}

export async function removePendingMeetingAudio(id: string): Promise<void> {
  return withStore<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

