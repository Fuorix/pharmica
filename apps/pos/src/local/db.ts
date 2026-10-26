/**
 * The counter's local database: JSON documents grouped into collections. In the desktop app it is SQLite
 * (through the Tauri SQL plugin); in a browser it is IndexedDB. Both survive restarts and power loss.
 */
export type Collection = "meta" | "outbox" | "sales" | "pins" | "customers" | "purchases" | "payments" | "master";

export interface Entry {
  collection: Collection;
  id: string;
  /** `undefined` deletes the document. */
  value: unknown;
}

export interface LocalDb {
  get<T>(collection: Collection, id: string): Promise<T | null>;
  all<T>(collection: Collection): Promise<T[]>;
  /** Writes all entries atomically: either every one is saved or none is. */
  write(entries: Entry[]): Promise<void>;
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function openSqlite(): Promise<LocalDb> {
  const { default: Database } = await import("@tauri-apps/plugin-sql");
  const sqlite = await Database.load("sqlite:pharmica.db");
  await sqlite.execute("PRAGMA journal_mode = WAL");
  await sqlite.execute("CREATE TABLE IF NOT EXISTS docs (collection TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (collection, id))");

  return {
    async get<T>(collection: Collection, id: string) {
      const rows = await sqlite.select<Array<{ value: string }>>("SELECT value FROM docs WHERE collection = $1 AND id = $2", [collection, id]);
      return rows[0] ? JSON.parse(rows[0].value) as T : null;
    },
    async all<T>(collection: Collection) {
      const rows = await sqlite.select<Array<{ value: string }>>("SELECT value FROM docs WHERE collection = $1 ORDER BY id", [collection]);
      return rows.map((row) => JSON.parse(row.value) as T);
    },
    async write(entries: Entry[]) {
      // All saves go in one INSERT statement, which SQLite applies atomically, so a sale and its outbox entry
      // land together. Deletes (only ever cleanup) run after it as a second statement.
      const now = new Date().toISOString();
      const upserts = entries.filter((entry) => entry.value !== undefined);
      const deletes = entries.filter((entry) => entry.value === undefined);
      if (upserts.length) {
        await sqlite.execute(
          `INSERT INTO docs (collection, id, value, updated_at) VALUES ${upserts.map((_, index) => `($${index * 4 + 1}, $${index * 4 + 2}, $${index * 4 + 3}, $${index * 4 + 4})`).join(", ")} ON CONFLICT (collection, id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          upserts.flatMap((entry) => [entry.collection, entry.id, JSON.stringify(entry.value), now])
        );
      }
      if (deletes.length) {
        await sqlite.execute(
          `DELETE FROM docs WHERE ${deletes.map((_, index) => `(collection = $${index * 2 + 1} AND id = $${index * 2 + 2})`).join(" OR ")}`,
          deletes.flatMap((entry) => [entry.collection, entry.id])
        );
      }
    }
  };
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

async function openIndexedDb(name = "pharmica-pos"): Promise<LocalDb> {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const store = opening.result.createObjectStore("docs", { keyPath: ["collection", "id"] });
    store.createIndex("collection", "collection");
  };
  const idb = await request(opening);

  return {
    async get<T>(collection: Collection, id: string) {
      const row = await request(idb.transaction("docs").objectStore("docs").get([collection, id])) as { value: T } | undefined;
      return row ? row.value : null;
    },
    async all<T>(collection: Collection) {
      const rows = await request(idb.transaction("docs").objectStore("docs").index("collection").getAll(collection)) as Array<{ id: string; value: T }>;
      return rows.sort((a, b) => a.id.localeCompare(b.id)).map((row) => row.value);
    },
    write(entries: Entry[]) {
      return new Promise<void>((resolve, reject) => {
        const transaction = idb.transaction("docs", "readwrite");
        const store = transaction.objectStore("docs");
        for (const entry of entries) {
          if (entry.value === undefined) store.delete([entry.collection, entry.id]);
          else store.put({ collection: entry.collection, id: entry.id, value: entry.value });
        }
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  };
}

/** An in-memory database for tests. */
export function memoryDb(): LocalDb {
  const docs = new Map<string, unknown>();
  const key = (collection: string, id: string) => `${collection}\u0000${id}`;
  return {
    async get<T>(collection: Collection, id: string) {
      const value = docs.get(key(collection, id));
      return value === undefined ? null : structuredClone(value) as T;
    },
    async all<T>(collection: Collection) {
      return [...docs.entries()].filter(([name]) => name.startsWith(`${collection}\u0000`)).sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => structuredClone(value) as T);
    },
    async write(entries: Entry[]) {
      for (const entry of entries) {
        if (entry.value === undefined) docs.delete(key(entry.collection, entry.id));
        else docs.set(key(entry.collection, entry.id), structuredClone(entry.value));
      }
    }
  };
}

let opened: Promise<LocalDb> | null = null;

export function openLocalDb(): Promise<LocalDb> {
  opened ??= isTauri() ? openSqlite() : openIndexedDb();
  return opened;
}
