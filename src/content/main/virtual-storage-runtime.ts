/**
 * 主世界运行时：按会话命名空间虚拟化 DOM 存储。
 * 启用时以 `sb:${sessionId}:` 前缀隔离 localStorage / sessionStorage 键；
 * sessionId 为空则恢复原生存储。
 */
(() => {
  let ns = '';

  interface StorageLike {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
    clear(): void;
    key(i: number): string | null;
    readonly length: number;
  }

  const REAL_LS = window.localStorage;
  const REAL_SS = window.sessionStorage;

  function count(real: Storage, nsKey: string): number {
    let n = 0;
    for (let i = 0; i < real.length; i += 1) {
      if (real.key(i)?.startsWith(nsKey)) n += 1;
    }
    return n;
  }

  function keys(real: Storage, nsKey: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < real.length; i += 1) {
      const k = real.key(i);
      if (k && k.startsWith(nsKey)) out.push(k);
    }
    return out;
  }

  function isolate(real: Storage, nsKey: string): StorageLike {
    return {
      get length() {
        return count(real, nsKey);
      },
      getItem(k) {
        return real.getItem(nsKey + k);
      },
      setItem(k, v) {
        real.setItem(nsKey + k, v);
      },
      removeItem(k) {
        real.removeItem(nsKey + k);
      },
      clear() {
        keys(real, nsKey).forEach((k) => real.removeItem(k));
      },
      key(i) {
        const list = keys(real, nsKey);
        const raw = list[i];
        return raw ? raw.slice(nsKey.length) : null;
      },
    };
  }

  function patchStorage(descKey: 'localStorage' | 'sessionStorage', facade: StorageLike): void {
    Object.defineProperty(window, descKey, {
      configurable: true,
      enumerable: true,
      get: () => facade,
      set: () => undefined,
    });
  }

  function apply(): void {
    if (!ns) {
      patchStorage('localStorage', REAL_LS);
      patchStorage('sessionStorage', REAL_SS);
      return;
    }
    const nsKey = `sb:${ns}:`;
    patchStorage('localStorage', isolate(REAL_LS, nsKey));
    patchStorage('sessionStorage', isolate(REAL_SS, nsKey));
  }

  window.addEventListener('sb:storage-enable', ((e: Event) => {
    const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
    const next = detail?.sessionId ?? '';
    if (next !== ns) {
      ns = next;
      apply();
    }
  }) as EventListener);
})();