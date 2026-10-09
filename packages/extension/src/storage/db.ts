import { IDB_NAME, IDB_STORE_ACCOUNTS, IDB_VERSION } from '../shared/constants';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const from = (event as IDBVersionChangeEvent).oldVersion;

      // ★ v3（2026-10-09）：`accounts` 仓的**语义换了**。
      //
      //   它原来是「本地账号库」——每行带一个 AES-GCM 加密的 `credentials`，
      //   密钥种子就在同一台机器的 `chrome.storage.local` 里。
      //   现在本地账号库被整体废除（只留云端），这个仓改存**云端快照的只读副本**，
      //   而那份副本**一个字节的口令都不含**。
      //
      //   ⇒ 所以升级时必须**先删再建**，把旧的（带口令密文的）行清干净。
      //     留着它们在库里既没用（没人读旧结构），又是一份"本不该再存在"的凭据材料。
      //     这是整个改造里唯一**故意丢数据**的地方，理由：这份数据的替代品
      //     在云端（用户登录后就有了），而留在本地才是风险。
      // ★ v3（2026-10-09）：`sessions` 仓整体删除。
      //   它是旧「会话模型」的库（`session-manager.ts` / `navigation.ts` /
      //   `account-registry.ts` 三个文件一起废除），而它每行都带一个
      //   AES-GCM 加密的 `credentials`。⇒ 与 accounts 仓同样的理由：清掉。
      if (from < 3 && db.objectStoreNames.contains('sessions')) {
        db.deleteObjectStore('sessions');
      }

      if (from < 3 && db.objectStoreNames.contains(IDB_STORE_ACCOUNTS)) {
        db.deleteObjectStore(IDB_STORE_ACCOUNTS);
      }
      if (!db.objectStoreNames.contains(IDB_STORE_ACCOUNTS)) {
        db.createObjectStore(IDB_STORE_ACCOUNTS, { keyPath: 'id' });
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
  /**
   * 账号仓。★ **现在只存云端快照的只读副本**（`CachedAccount`，无 `credentials`）。
   *
   * 之所以不再叫 `db.accounts.put/delete`（那样会让人以为还能逐条改），
   * 是因为**缓存不是数据源**：它只能整份替换（`replaceAll`）。
   * 保留逐条写的能力，迟早会有人用它做"本地编辑"，而那就是被废除的那套东西。
   */
  accounts: {
    async list(): Promise<unknown[]> {
      return tx<unknown[]>(IDB_STORE_ACCOUNTS, 'readonly', (s) => s.getAll() as IDBRequest<unknown[]>);
    },

    /**
     * 整份替换（清空 + 写入，**同一个事务**）。
     *
     * ★ 必须在同一个事务里：分成"先 clear 再 put"两次事务的话，
     *   崩在中间会留下一份**空缓存**，而空缓存会让离线时看到"一个账号都没有" ——
     *   那看起来像"我的账号丢了"，比"用旧数据"糟得多。
     */
    replaceAll(rows: unknown[]): Promise<void> {
      return openDb().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const t = db.transaction(IDB_STORE_ACCOUNTS, 'readwrite');
            const store = t.objectStore(IDB_STORE_ACCOUNTS);
            store.clear();
            for (const row of rows) {
              store.put(row);
            }
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
          }),
      );
    },
  },
};
