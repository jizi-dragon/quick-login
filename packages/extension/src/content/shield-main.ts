/**
 * Shield Main —— MAIN world，document_start 注入。
 *
 * 双平面隔离的存储平面（页面侧）v2.7：
 * 1. Storage.prototype 方法级补丁 —— 绑定标签页的 localStorage 全部键重定向到
 *    `__ql_ns_<accountId>__` 命名空间；
 * 2. document.cookie 完全虚拟化 —— 该站登录后服务端经 Set-Cookie 把 token 副本写进
 *    「真实 Cookie jar」（全标签页共享，是 v2.6 实测串号的泄漏通道）。激活后页面读写的
 *    cookie 改存于命名空间内的「Cookie 袋」（__ql_cookies__ JSON），真实 jar 永不被读取；
 * 3. 种子直灌 —— bind 载荷携带后台保存的账号快照（token 等），激活瞬间同步灌入，
 *    杜绝「先跑的页面代码读到别人/空值」的启动竞态；
 * 4. 写入上报 —— 命名空间内 __auth_token__ 等键的变化经桥上报 background（token 捕获通道）。
 */

(() => {
  const win = window as typeof window & { __QL_SHIELD_INSTALLED__?: boolean };
  if (win.__QL_SHIELD_INSTALLED__) {
    return;
  }
  win.__QL_SHIELD_INSTALLED__ = true;

  const WATCH_KEYS = ['__auth_token__', '__auth_user__', '__device_fp__'];
  const TOKEN_KEY = '__auth_token__';
  const NS_TAG = '__ql_ns_';
  const COOKIE_BAG_KEY = '__ql_cookies__';
  const BOOT_GUARD_KEY = '__ql_boot_guard';
  const SRC_PAGE_TO_BRIDGE = 'QL_PAGE_TO_BRIDGE';
  const SRC_BRIDGE_TO_PAGE = 'QL_BRIDGE_TO_PAGE';

  type Mode = 'passthrough' | 'active';
  let mode: Mode = 'passthrough';
  let ns = '';
  let settled = false;

  /* ---- 原生方法引用（必须在任何补丁之前捕获） ---- */
  const proto = Storage.prototype;
  const origGetItem = proto.getItem;
  const origSetItem = proto.setItem;
  const origRemoveItem = proto.removeItem;
  const origKey = proto.key;
  const origLengthDesc = Object.getOwnPropertyDescriptor(proto, 'length');
  const cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
    ?? Object.getOwnPropertyDescriptor(document, 'cookie');

  /* ================= Cookie 袋（document.cookie 的虚拟视图） ================= */

  let bag: Record<string, string> | null = null;

  function loadBag(): Record<string, string> {
    if (bag) {
      return bag;
    }
    try {
      bag = JSON.parse(origGetItem.call(window.localStorage, ns + COOKIE_BAG_KEY) ?? '{}') as Record<string, string>;
    } catch {
      bag = {};
    }
    if (typeof bag !== 'object' || bag === null) {
      bag = {};
    }
    return bag!;
  }

  function saveBag(): void {
    try {
      origSetItem.call(window.localStorage, ns + COOKIE_BAG_KEY, JSON.stringify(loadBag()));
    } catch {
      // 存储满等极端场景忽略；袋与 LS 短暂不一致优于崩溃
    }
  }

  function bagSet(key: string, value: string): void {
    loadBag();
    if (value === '') {
      delete bag![key];
    } else {
      bag![key] = value;
    }
    saveBag();
  }

  function installCookieVirtualization(): void {
    if (!cookieDesc?.configurable) {
      return;
    }
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get(this: Document): string {
        const b = loadBag();
        return Object.entries(b)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
      },
      set(this: Document, text: string): void {
        // 仅取首个分号前的 k=v 对；path/domain/expires 等属性对页内读取无意义，忽略
        const firstChunk = String(text).split(';')[0] ?? '';
        const eq = firstChunk.indexOf('=');
        if (eq <= 0) {
          return;
        }
        const key = firstChunk.slice(0, eq).trim();
        const value = firstChunk.slice(eq + 1).trim();
        if (!key) {
          return;
        }
        bagSet(key, decodeURIComponentSafe(value));
      },
    });
  }

  function decodeURIComponentSafe(v: string): string {
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }

  /* ================= 上行报告（经桥转 background） ================= */

  function reportStorageWrite(key: string, value: string | null): void {
    if (!WATCH_KEYS.includes(key)) {
      return;
    }
    window.postMessage(
      { src: SRC_PAGE_TO_BRIDGE, payload: { op: 'storageWrite', key, value } },
      '*',
    );
  }

  function reportAuthHeader(value: string): void {
    window.postMessage(
      { src: SRC_PAGE_TO_BRIDGE, payload: { op: 'authHeader', value } },
      '*',
    );
  }

  /* ---- fetch / XHR 出站 Authorization 头嗅探（token 二级捕获通道，只观察不修改） ---- */
  function patchNetworkSniffers(): void {
    const nativeFetch = win.fetch;
    const sniffFetch = function (
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      try {
        let headers: Headers | undefined;
        if (init && init.headers) {
          headers = new Headers(init.headers as HeadersInit);
        } else if (input instanceof Request) {
          headers = input.headers;
        }
        const auth = headers?.get('authorization');
        if (auth) {
          reportAuthHeader(auth);
        }
      } catch {
        // 探测失败不影响请求本身
      }
      return nativeFetch.call(this, input, init);
    };
    win.fetch = sniffFetch as typeof win.fetch;

    const xhrProto = XMLHttpRequest.prototype as unknown as Record<string, unknown>;
    const nativeSetHeader = xhrProto.setRequestHeader as (n: string, v: string) => void;
    const nativeSend = xhrProto.send as (...args: unknown[]) => void;
    const AUTH_SLOT = Symbol('__ql_auth__');
    xhrProto.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string): void {
      if (name.toLowerCase() === 'authorization') {
        (this as unknown as Record<symbol, string>)[AUTH_SLOT] = value;
      }
      nativeSetHeader.call(this, name, value);
    } as typeof XMLHttpRequest.prototype.setRequestHeader;
    xhrProto.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null): void {
      const auth = (this as unknown as Record<symbol, string | undefined>)[AUTH_SLOT];
      if (auth) {
        reportAuthHeader(auth);
      }
      return nativeSend.apply(this, [body] as unknown[]);
    } as typeof XMLHttpRequest.prototype.send;
  }

  /* ================= Storage.prototype 补丁 ================= */

  function realLength(storage: Storage): number {
    if (origLengthDesc && origLengthDesc.get) {
      return origLengthDesc.get.call(storage);
    }
    return 0;
  }

  function namespaceKeys(storage: Storage): string[] {
    const out: string[] = [];
    const len = realLength(storage);
    for (let i = 0; i < len; i++) {
      const k = origKey.call(storage, i);
      if (k !== null && k.startsWith(ns)) {
        out.push(k);
      }
    }
    return out;
  }

  /** 命名空间内的写入：保持 Cookie 袋同步（单一事实源） */
  function onNamespaceWrite(storage: Storage, bareKey: string, rawKey: string, value: string | null): void {
    if (bareKey === TOKEN_KEY) {
      if (value === null) {
        bagSet(TOKEN_KEY, '');
        origRemoveItem.call(storage, rawKey);
      } else {
        bagSet(TOKEN_KEY, value);
      }
    }
    reportStorageWrite(bareKey, value);
  }

  function installStoragePatch(): void {
    Object.defineProperty(proto, 'getItem', {
      configurable: true,
      writable: true,
      value: function (this: Storage, key: string): string | null {
        return origGetItem.call(this, ns + String(key));
      },
    });
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      writable: true,
      value: function (this: Storage, key: string, value: string): void {
        const bare = String(key);
        const raw = ns + bare;
        const val = String(value);
        origSetItem.call(this, raw, val);
        onNamespaceWrite(this, bare, raw, val);
      },
    });
    Object.defineProperty(proto, 'removeItem', {
      configurable: true,
      writable: true,
      value: function (this: Storage, key: string): void {
        const bare = String(key);
        const raw = ns + bare;
        origRemoveItem.call(this, raw);
        onNamespaceWrite(this, bare, raw, null);
      },
    });
    Object.defineProperty(proto, 'clear', {
      configurable: true,
      writable: true,
      value: function (this: Storage): void {
        // 仅清空本账号命名空间 + Cookie 袋，等价「该标签页视角下的 clear」
        for (const raw of namespaceKeys(this)) {
          origRemoveItem.call(this, raw);
        }
        bag = {};
        saveBag();
      },
    });
    Object.defineProperty(proto, 'key', {
      configurable: true,
      writable: true,
      value: function (this: Storage, index: number): string | null {
        const keys = namespaceKeys(this).filter((k) => k !== ns + COOKIE_BAG_KEY);
        if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
          return null;
        }
        return keys[index].slice(ns.length);
      },
    });
    Object.defineProperty(proto, 'length', {
      configurable: true,
      get: function (this: Storage): number {
        return namespaceKeys(this).filter((k) => k !== ns + COOKIE_BAG_KEY).length;
      },
    });

    installCookieVirtualization();
    patchNetworkSniffers();
  }

  /* ================= 绑定处理 ================= */

  function activate(accountId: string, seed?: Record<string, string>): void {
    if (mode === 'active') {
      return;
    }
    mode = 'active';
    ns = `${NS_TAG}${accountId}__`;
    installStoragePatch();
    applySeed(seed);
  }

  /** 种子直灌：不经补丁层静默写入命名空间（并同步 token 进 Cookie 袋） */
  function applySeed(seed?: Record<string, string>): void {
    if (!seed) {
      return;
    }
    for (const [key, value] of Object.entries(seed)) {
      if (typeof value !== 'string' || !value) {
        continue;
      }
      try {
        origSetItem.call(window.localStorage, ns + key, value);
        if (key === TOKEN_KEY) {
          bagSet(TOKEN_KEY, value);
        }
      } catch {
        // 单键失败不阻断其余种子
      }
    }
  }

  function handleBind(accountId: string, seed?: Record<string, string>): void {
    if (settled) {
      // 已绑定其它路径：仍允许把种子补进当前命名空间（幂等）
      applySeed(seed);
      return;
    }
    settled = true;

    if (document.readyState === 'loading') {
      activate(accountId, seed);
      return;
    }

    // 页面 bundle 已在无命名空间状态下执行：刷新一次重来（守卫防循环）。
    if (window.sessionStorage.getItem(BOOT_GUARD_KEY) === '1') {
      window.sessionStorage.removeItem(BOOT_GUARD_KEY);
      activate(accountId, seed);
      return;
    }
    window.sessionStorage.setItem(BOOT_GUARD_KEY, '1');
    window.location.reload();
  }

  /* ---- 下行监听 + 握手重试 ---- */
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    const data = event.data as { src?: string; payload?: { op?: string; accountId?: string; seed?: Record<string, string> } } | null;
    if (!data || data.src !== SRC_BRIDGE_TO_PAGE) {
      return;
    }
    const payload = data.payload;
    if (payload && payload.op === 'bind' && typeof payload.accountId === 'string') {
      handleBind(payload.accountId, payload.seed);
    } else if (payload && payload.op === 'unbound') {
      settled = true; // 显式未绑定：保持直通，不再等待
    }
  });

  function hello(attempt: number): void {
    if (attempt <= 0) {
      return;
    }
    window.setTimeout(() => {
      if (!settled) {
        window.postMessage(
          { src: SRC_PAGE_TO_BRIDGE, payload: { op: 'hello', url: location.href } },
          '*',
        );
        hello(attempt - 1);
      }
    }, 120);
  }

  window.postMessage({ src: SRC_PAGE_TO_BRIDGE, payload: { op: 'hello', url: location.href } }, '*');
  hello(6);
})();
