import { IDB_NAME, IDB_STORE_SESSIONS, IDB_STORE_COOKIE_BAGS, IDB_VERSION } from '../shared/constants';
import type { CookieBag, Session } from '../shared/types';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE_SESSIONS)) {
        db.createObjectStore(IDB_STORE_SESSIONS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(IDB_STORE_COOKIE_BAGS)) {
        db.createObjectStore(IDB_STORE_COOKIE_BAGS, { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export const db = {
  sessions: {
    async list(): Promise<Session[]> {
      return tx<Session[]>(IDB_STORE_SESSIONS, 'readonly', (s) => s.getAll() as IDBRequest<Session[]>);
    },
    async get(id: string): Promise<Session | undefined> {
      return tx<Session | undefined>(IDB_STORE_SESSIONS, 'readonly', (s) => s.get(id) as IDBRequest<Session | undefined>);
    },
    async put(session: Session): Promise<void> {
      await tx(IDB_STORE_SESSIONS, 'readwrite', (s) => s.put(session));
    },
    async delete(id: string): Promise<void> {
      await tx(IDB_STORE_SESSIONS, 'readwrite', (s) => s.delete(id));
    },
  },
  cookieBags: {
    async get(sessionId: string): Promise<CookieBag | undefined> {
      return tx<CookieBag | undefined>(IDB_STORE_COOKIE_BAGS, 'readonly', (s) => s.get(sessionId) as IDBRequest<CookieBag | undefined>);
    },
    async put(bag: CookieBag): Promise<void> {
      await tx(IDB_STORE_COOKIE_BAGS, 'readwrite', (s) => s.put(bag));
    },
    async delete(sessionId: string): Promise<void> {
      await tx(IDB_STORE_COOKIE_BAGS, 'readwrite', (s) => s.delete(sessionId));
    },
  },
};