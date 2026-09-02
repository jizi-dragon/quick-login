import { CONTENT_MESSAGE, LOCAL_KEYS, SESSION_KEYS } from '../../shared/constants';
import type { BridgeDownPayload, BridgeUpPayload, ParallelAccount } from '../../shared/types';
import { credentials } from './credentials';
import { setTabTitle } from '../tabs/tab-title';
import { parallelStore } from './parallel-store';
import { tabRules } from './tab-rules';

/**
 * 「多平面隔离」运行时编排（纯扩展多账号并行，见 docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md §4）：
 * - 存储平面：MAIN 壳把绑定标签页的 localStorage / document.cookie 重定向到账号命名空间；
 *   桥接脚本上报 `__auth_token__` 等键的写入 → 本模块捕获 token 快照。
 * - 网络平面：每绑定标签两条 DNR 规则——Authorization 改写 + 出站 Cookie 头剥离（v3 新增，
 *   封堵「真实 jar = 最后登录者」的串号通道）。
 * - 授权健康：host 缺少浏览器授权或被手动停用时，网络平面整体关闭并在 UI 显著提示。
 */

interface ParBinding {
  accountId: string;
  host: string;
}

interface TokenSnapshot {
  token?: string;
  authUser?: string;
  deviceFp?: string;
  /**
   * 登录时点的站内 Cookie 快照（含 HttpOnly，经 chrome.cookies 读取；身份类黑名单除外，
   * 见 IDENTITY_COOKIE_BLACKLIST）。用于 DNR Cookie 头「按账号回放」（v3.6 对齐 SessionBox
   * 核心机制）：绑定标签页的出站请求不再依赖共享真实 jar，服务端始终看到一致会话身份。
   * 仅在该账号首次捕获 token（即登录刚完成、jar 尚未被后续登录污染）时采集。
   */
  cookies?: { name: string; value: string }[];
}

const bindings = new Map<number, ParBinding>();
const tokens = new Map<string, TokenSnapshot>();
/** 授权健康缓存：host → 是否可执行（已授权且未被手动停用） */
const enforcement = new Map<string, boolean>();

/** 诊断埋点：写入 storage.local['ql:diag']（环形 60 条），供 E2E 台架经扩展页读取 */
async function diag(msg: string): Promise<void> {
  try {
    const key = 'ql:diag';
    const cur = (await chrome.storage.local.get(key))[key] as string[] | undefined;
    const next = [...(cur ?? []).slice(-59), `${new Date().toISOString().slice(11, 23)} ${msg}`];
    await chrome.storage.local.set({ [key]: next });
  } catch {
    // 埋点失败不影响业务
  }
}

async function readBlockedHosts(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  return new Set((stored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);
}

/** 检查某 host 的网络平面是否可执行（带缓存的授权 + 封锁名单判定） */
async function isEnforceable(host: string): Promise<boolean> {
  const cached = enforcement.get(host);
  if (cached !== undefined) {
    void diag(`isEnforceable(${host}) → 缓存 ${cached}`);
    return cached;
  }
  const blocked = await readBlockedHosts();
  if (blocked.has(host)) {
    enforcement.set(host, false);
    void diag(`isEnforceable(${host}) → false（本地停用名单）`);
    return false;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [`*://${host}/*`] });
  } catch {
    granted = false;
  }
  // 更宽泛的通配授权也算可用
  if (!granted) {
    try {
      granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    } catch {
      granted = false;
    }
  }
  enforcement.set(host, granted);
  void diag(`isEnforceable(${host}) → ${granted}（permissions.contains 实查）`);
  return granted;
}

/** 强制刷新授权缓存（授权增撤后调用） */
export function invalidateEnforcementCache(): void {
  enforcement.clear();
}

/** 预热授权健康缓存（par.list 调用，供 statusOf 同步读取；isEnforceable 有缓存，稳态开销近零） */
export async function warmEnforcementCache(hosts: string[]): Promise<void> {
  await Promise.all([...new Set(hosts)].map((h) => isEnforceable(h).catch(() => undefined)));
}

async function readState(): Promise<void> {
  const [bindStored, tokenStored] = await Promise.all([
    chrome.storage.session.get(SESSION_KEYS.parTabBindings),
    chrome.storage.session.get(SESSION_KEYS.parTokens),
  ]);
  bindings.clear();
  const bindMap = bindStored[SESSION_KEYS.parTabBindings] as Record<string, ParBinding> | undefined;
  if (bindMap) {
    for (const [tabId, b] of Object.entries(bindMap)) {
      bindings.set(Number(tabId), b);
    }
  }
  tokens.clear();
  const tokenMap = tokenStored[SESSION_KEYS.parTokens] as Record<string, TokenSnapshot> | undefined;
  if (tokenMap) {
    for (const [id, t] of Object.entries(tokenMap)) {
      tokens.set(id, t);
    }
  }
}

async function persistBindings(): Promise<void> {
  const map: Record<string, ParBinding> = {};
  for (const [tabId, b] of bindings) {
    map[String(tabId)] = b;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.parTabBindings]: map });
}

async function persistTokens(): Promise<void> {
  const map: Record<string, TokenSnapshot> = {};
  for (const [id, t] of tokens) {
    map[id] = t;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.parTokens]: map });
}

/* ---------------- 标题与待登录凭证（复用既有内容脚本协议） ---------------- */

async function applyTitle(tabId: number, tabName: string): Promise<void> {
  await setTabTitle(tabId, tabName);
  try {
    await chrome.tabs.sendMessage(tabId, { type: CONTENT_MESSAGE.setTitle, alias: tabName });
  } catch {
    // 内容脚本未就绪：标题已权威写入；后续 onUpdated 会再推
  }
}

/** 与 navigation.ts 相同约定的待登录凭证缓存（auto-login 内容脚本按 tabId 拉取） */
async function setPendingAutoLogin(tabId: number, username: string, password: string): Promise<void> {
  await chrome.storage.session.set({
    [`${SESSION_KEYS.pendingAutoLogins}:${tabId}`]: { username, password, at: Date.now() },
  });
}

function boundTabsOf(accountId: string): number[] {
  const out: number[] = [];
  for (const [tabId, b] of bindings) {
    if (b.accountId === accountId) {
      out.push(tabId);
    }
  }
  return out;
}

/* ---------------- token 捕获 → DNR 规则同步（网络平面写入点） ---------------- */

async function captureToken(accountId: string, host: string, rawToken: string): Promise<void> {
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7).trim() : rawToken.trim();
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) {
    return; // 仅接受形如 JWT 的值，避免把页面噪声写进规则
  }
  const snap = tokens.get(accountId) ?? {};
  if (snap.token === token) {
    return; // 去重
  }
  const isFirstCapture = !snap.token; // 首次捕获 = 登录刚完成：此刻真实 jar 即该账号会话
  snap.token = token;
  tokens.set(accountId, snap);
  await persistTokens();
  // 快照触发必须在 captureToken 内部：token 首捕可能来自 authHeader 嗅探（早于
  // storageWrite 事件），两条通道都必须覆盖，否则错过登录时点（v3.6.1 修复）
  if (isFirstCapture) {
    await snapshotLoginCookies(accountId, host);
  }
  await syncAccountRules(accountId, host);
}

/**
 * 身份类 Cookie 黑名单：这些名字由平台 JS 写入真实 jar（普通/未接管页签无虚拟化保护），
 * 值 = 「jar 里最后写它的那个账号」。快照若包含它们，回放就会把别人的身份带给本账号
 * 的请求（3.7.2 修复：真实环境复现「普通用户获得管理员」——普通页签登录态残留 jar，
 * 被下一次任意账号的登录时点快照打包）。回放只需 WAF 会话对等非身份 Cookie。
 */
const IDENTITY_COOKIE_BLACKLIST = new Set(['__auth_token__', '__auth_user__', '__device_fp__']);

/* ---------------- 会话卫生（v3.10.2）：真实 jar 永不留存扩展账号的会话 Cookie ----------------
 * 冲突机制：绑定页签登录时响应 Set-Cookie 不经拦截直接落入真实 jar；此后用户 Ctrl+T 的
 * 原始页签出站时带着的就是扩展账号的会话 Cookie——站点按会话轮换逻辑「新登录作废旧会话」，
 * 快速登录的账号被顶掉（原始登录与快速登录互相冲突）。
 * 对策：扩展账号页签完全依赖快照回放（与真实 jar 无关），因此 jar 中的扩展会话 Cookie 可
 * 安全移除——原始页签从此天然匿名，原始登录 = 全新会话，互不顶号。
 * 三层防线：
 *  1. preJar 基线：open() 建页签前记录 jar；
 *  2. 差集清扫：快照首捕时移除「本次登录新写入」的 Cookie（不动登录前已存在的，如原始会话）；
 *  3. onChanged 持续驱逐：凡是 (name,value) 命中任一账号快照对（或 __auth_token__ 命中任一
 *     账号 token）的写 jar 行为，立即移除——覆盖后续请求重新 Set-Cookie 的重入。
 */

interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}

/** 登录前 jar 基线（按账号；SW 重启丢失则跳过清扫，保守不误杀） */
const preJarMap = new Map<string, JarCookie[]>();

async function capturePreJar(accountId: string, host: string): Promise<void> {
  try {
    preJarMap.set(accountId, (await chrome.cookies.getAll({ url: `https://${host}/` })) as JarCookie[]);
  } catch {
    preJarMap.delete(accountId);
  }
}

function cookieUrl(c: { domain: string; path: string; secure: boolean }): string {
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

/** 从真实 jar 移除一枚 Cookie（幂等；失败静默——可能已被站点的过期指令处理） */
async function removeJarCookie(c: { name: string; domain: string; path: string; secure: boolean }): Promise<void> {
  try {
    await chrome.cookies.remove({ url: cookieUrl(c), name: c.name });
  } catch {
    // 幂等目标，失败忽略
  }
}

/** 快照首捕后按差集清扫：只移除「本次登录新写入」的 Cookie，保留登录前已存在的（如原始会话） */
async function sweepLoginCookiesFromJar(accountId: string, host: string, captured: Array<{ name: string; value: string }>): Promise<void> {
  const pre = preJarMap.get(accountId);
  if (!pre) {
    void diag(`sweep(${accountId}) 跳过：无登录前基线（SW 重启）——依赖 onChanged 驱逐兜底`);
    return;
  }
  const preKeys = new Set(pre.map((c) => `${c.name}|${c.value}`));
  const jarNow = (await chrome.cookies.getAll({ url: `https://${host}/` }).catch(() => [])) as JarCookie[];
  let removed = 0;
  for (const c of jarNow) {
    // 差集成员：在 jar 中、被快照捕获、但登录前不存在 → 本会话写入的扩展 Cookie
    if (!preKeys.has(`${c.name}|${c.value}`) && captured.some((k) => k.name === c.name && k.value === c.value)) {
      await removeJarCookie(c);
      removed++;
    }
  }
  preJarMap.delete(accountId);
  void diag(`sweep(${accountId}) 差集清扫 ${removed} 枚（jar 现存 ${jarNow.length}）`);
}

/** onChanged 持续驱逐：命中任一账号快照对（或身份 token）的写 jar 行为立即移除 */
async function evictJarCookie(change: chrome.cookies.CookieChangeInfo): Promise<void> {
  const c = change.cookie;
  if (!c.value) {
    return; // 移除事件本身
  }
  const known = new Set<string>();
  for (const snap of tokens.values()) {
    for (const k of snap.cookies ?? []) {
      known.add(`${k.name}|${k.value}`);
    }
    if (snap.token) {
      known.add(`__auth_token__|${snap.token}`);
    }
  }
  if (!known.has(`${c.name}|${c.value}`)) {
    return;
  }
  await removeJarCookie(c);
  void diag(`evict jar cookie ${c.name}（命中账号快照）@ ${c.domain}`);
}

/** 登录时点快照该账号的站内 Cookie（含 HttpOnly，剔除身份类黑名单）进账号档案 */
async function snapshotLoginCookies(accountId: string, host: string): Promise<void> {
  const snap = tokens.get(accountId);
  if (!snap?.token) {
    return;
  }
  try {
    const list = await chrome.cookies.getAll({ url: `https://${host}/` });
    const before = list.length;
    snap.cookies = list
      .filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name))
      .map((c) => ({ name: c.name, value: c.value }));
    tokens.set(accountId, snap);
    await persistTokens();
    void diag(`snapshotLoginCookies(${accountId}) 快照 ${snap.cookies.length} 条（jar 共 ${before}，剔身份类 ${before - snap.cookies.length}）`);
    // 会话卫生：把本次登录写入真实 jar 的差集 Cookie 移除（原始页签从此匿名登录，不顶号）
    await sweepLoginCookiesFromJar(accountId, host, snap.cookies);
  } catch (e) {
    void diag(`snapshotLoginCookies(${accountId}) 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

function cookieHeaderOf(accountId: string): string | null {
  const cs = tokens.get(accountId)?.cookies;
  if (!cs || !cs.length) {
    return null;
  }
  // 回放侧再过滤一次：3.7.2 之前保存的存量快照可能已含身份类 Cookie（jar 残留），
  // 无需用户重新登录即生效
  const filtered = cs.filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name));
  if (!filtered.length) {
    return null;
  }
  return filtered.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 把某账号当前 token 同步到其全部绑定标签页的规则（受授权健康门控） */
async function syncAccountRules(accountId: string, host: string): Promise<void> {
  const bound = boundTabsOf(accountId);
  void diag(`syncAccountRules(${accountId}) 绑定标签=${bound.join(',') || '无'}`);
  if (!(await isEnforceable(host))) {
    void diag(`syncAccountRules(${accountId}) 跳过：授权不可执行`);
    return; // 授权缺失/停用：不装规则，UI 通过 enforcementOff 提示
  }
  const token = tokens.get(accountId)?.token ?? null;
  const cookieHeader = cookieHeaderOf(accountId);
  try {
    await Promise.all(bound.map((tabId) => tabRules.applyBinding(host, tabId, token, cookieHeader)));
    void diag(
      `syncAccountRules(${accountId}) 完成：applyBinding ×${bound.length}（token=${token ? '有' : '无'} cookie=${cookieHeader ? `${cookieHeader.length}B` : '剥离'}）`,
    );
  } catch (e) {
    void diag(`syncAccountRules(${accountId}) 异常：${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/* ---------------- 绑定生命周期 ---------------- */

export const parallelSession = {
  /** 打开（或新建）账号标签页并完成绑定 */
  async open(accountId: string, forceNewTab = false): Promise<{ tabId: number; reused: boolean }> {
    void diag(`open(${accountId}) 入口`);
    const account = await parallelStore.get(accountId);
    let tabId: number | null = null;

    if (!forceNewTab) {
      const existing = boundTabsOf(accountId)[0];
      if (existing !== undefined && (await tabStillAlive(existing))) {
        tabId = existing;
      }
    }

    if (tabId === null) {
      // 登录前基线：记录打开时刻的真实 jar，快照首捕时按差集清扫（v3.10.2 会话卫生）
      await capturePreJar(account.id, account.siteHost);
      const hasToken = Boolean(tokens.get(accountId)?.token);
      // 已有登录态直达站点根路径；否则进登录页自动填表
      const url = `https://${account.siteHost}${hasToken ? '/' : '/login'}`;
      const tab = await chrome.tabs.create({ url });
      tabId = tab.id!;
      void diag(`open(${accountId}) 新建 tab=${tabId} url=${url}`);
    } else {
      await chrome.tabs.update(tabId, { active: true });
      void diag(`open(${accountId}) 复用 tab=${tabId}`);
    }

    bindings.set(tabId, { accountId: account.id, host: account.siteHost });
    await persistBindings();
    void diag(`open(${accountId}) 绑定已持久化`);

    if (account.credentials) {
      try {
        const creds = await credentials.decryptCredentials(account.credentials);
        await setPendingAutoLogin(tabId, creds.username, creds.password);
        void diag(`open(${accountId}) 凭证解密并下发待登录`);
      } catch (e) {
        // 凭证损坏不应阻断网络平面安装（原实现会让 open() 在此中断）
        void diag(`open(${accountId}) 凭证解密失败：${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      void diag(`open(${accountId}) 无凭证字段`);
    }

    // 推送绑定种子：桥转发给 MAIN 壳（壳在 committed 前后到达均可自举）
    await pushBind(tabId);
    void diag(`open(${accountId}) pushBind 完成`);
    await applyTitle(tabId, account.tabName);
    await syncAccountRules(account.id, account.siteHost);
    void diag(`open(${accountId}) 完成 tabId=${tabId}`);
    return { tabId, reused: false };
  },

  /** 解绑单个标签页（不动账号数据） */
  async unbindTab(tabId: number): Promise<void> {
    if (bindings.delete(tabId)) {
      await persistBindings();
    }
    await tabRules.clearTab(tabId);
    try {
      await pushDown(tabId, { op: 'unbound' });
    } catch {
      // 页面可能已关闭
    }
  },

  /**
   * 站点自开的新页签亲子继承（window.open / target=_blank）：opener 已绑定账号 A
   * → 新页签自动绑定为 A 的第二个页签（AUTH/COOKIE 规则、种子、命名空间、标题全随 A）。
   * 手动 Ctrl+T（无 openerTabId）不继承，保留有意脱离的口子。
   */
  async adoptFromOpener(tab: chrome.tabs.Tab): Promise<void> {
    const openerId = tab.openerTabId;
    const tabId = tab.id;
    if (openerId === undefined || tabId === undefined) {
      return;
    }
    const parent = bindings.get(openerId);
    if (!parent || bindings.has(tabId)) {
      return;
    }
    const account = await parallelStore.get(parent.accountId).catch(() => undefined);
    if (!account) {
      return;
    }
    // 弹窗继承页签的登录若发生在绑定之后，其 Set-Cookie 属于差集，可被清扫（best-effort 基线）
    if (!tokens.get(account.id)?.token) {
      await capturePreJar(account.id, parent.host);
    }
    bindings.set(tabId, { accountId: account.id, host: parent.host });
    await persistBindings();
    await syncAccountRules(account.id, parent.host);
    await pushBind(tabId);
    await applyTitle(tabId, account.tabName);
    void diag(`adopt tab=${tabId} ← opener=${openerId} 账号=${account.id}（亲子继承）`);
  },

  /** 删除账号：关闭其全部绑定标签页、摘除规则、清 token */
  async deleteAccount(accountId: string): Promise<void> {
    const tabs = boundTabsOf(accountId);
    for (const tabId of tabs) {
      await this.unbindTab(tabId);
    }
    if (tabs.length) {
      await chrome.tabs.remove(tabs).catch(() => undefined);
    }
    tokens.delete(accountId);
    await persistTokens();
    await parallelStore.delete(accountId);
  },

  /** ISOLATED 桥上行消息入口 */
  async handleBridge(payload: BridgeUpPayload, tabId: number | undefined): Promise<BridgeDownPayload | undefined> {
    if (payload.op === 'hello') {
      if (tabId !== undefined) {
        const binding = bindings.get(tabId);
        if (binding) {
          return buildBindPayload(binding.accountId, tabId);
        }
      }
      return { op: 'unbound' };
    }
    if (tabId === undefined) {
      return undefined;
    }
    const binding = bindings.get(tabId);
    if (!binding) {
      return undefined;
    }
    if (payload.op === 'storageWrite') {
      const snap = tokens.get(binding.accountId) ?? {};
      if (payload.key === '__auth_token__') {
        if (payload.value === null) {
          // 页面内登出：清 token + 摘规则
          delete snap.token;
          delete snap.cookies;
          tokens.set(binding.accountId, snap);
          await persistTokens();
          await syncAccountRules(binding.accountId, binding.host);
        } else {
          await captureToken(binding.accountId, binding.host, payload.value);
          // 快照触发已内聚到 captureToken（首捕可能来自 authHeader 嗅探通道）
        }
      } else if (payload.key === '__auth_user__') {
        snap.authUser = payload.value ?? undefined;
        tokens.set(binding.accountId, snap);
        await persistTokens();
      } else if (payload.key === '__device_fp__') {
        snap.deviceFp = payload.value ?? undefined;
        tokens.set(binding.accountId, snap);
        await persistTokens();
      }
      return undefined;
    }
    if (payload.op === 'authHeader') {
      // 二级捕获通道：fetch/XHR 出站 Authorization 头嗅探
      await captureToken(binding.accountId, binding.host, payload.value);
      return undefined;
    }
    return undefined;
  },

  /**
   * UI 列表：返回实时状态（绑定标签页 / token / 网络平面健康）。
   * host 取绑定标签页的，无绑定时取账号自身 siteHost；授权健康读取 isEnforceable
   * 的同步缓存（par.list 已预先预热）——修复旧实现「无绑定账号永远显示离线、
   * 未授权状态不可见」的问题。
   */
  statusOf(account: ParallelAccount): { tabIds: number[]; hasToken: boolean; enforcementOff: boolean } {
    const tabs = boundTabsOf(account.id);
    const host = tabs.length ? bindings.get(tabs[0])?.host : account.siteHost;
    // 仅「明确缓存为 false」才判未授权；未知（缓存空/SW 冷启未暖）不得误报——
    // v3.10.1 修复：导入后即使权限已授，缓存未暖也会显示「未授权·已暂停」
    const enforcementOff = host ? enforcement.get(host) === false : true;
    return { tabIds: tabs, hasToken: Boolean(tokens.get(account.id)?.token), enforcementOff };
  },

  /** 账号改名后刷新所有绑定标签页标题 */
  async refreshTitle(accountId: string): Promise<void> {
    const account = await parallelStore.get(accountId);
    await Promise.all(boundTabsOf(accountId).map((t) => applyTitle(t, account.tabName)));
  },

  /** 诊断用内部状态快照（经 ql.diag 消息暴露给台架） */
  debugState(): Record<string, unknown> {
    return {
      bindings: Array.from(bindings.entries()).map(([t, b]) => ({ t, accountId: b.accountId, host: b.host })),
      tokenAccounts: Array.from(tokens.keys()),
      enforcement: Array.from(enforcement.entries()).map(([h, ok]) => `${h}=${ok}`),
    };
  },

  /* ------- 导航事件钩子（由 registerParallelHandlers 驱动） ------- */

  /** 标签页导航开始：重新推绑定种子与标题（SPA/整页刷新都会重置） */
  async onNavigation(tabId: number): Promise<void> {
    const binding = bindings.get(tabId);
    if (!binding) {
      return;
    }
    // 授权域护栏：绑定页签漫游到其它未授权 http(s) 域 → 解绑摘规则，
    // 防止账号种子/身份头流向非授权域（异域弹窗跳转、手动改址）。自身 host 不受影响。
    let url = '';
    try {
      url = (await chrome.tabs.get(tabId)).url ?? '';
    } catch {
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      const host = new URL(url).hostname;
      if (host !== binding.host && !(await isEnforceable(host))) {
        void diag(`onNavigation 非授权域 ${host}：解除 tab=${tabId} 绑定`);
        await this.unbindTab(tabId);
        return;
      }
    }
    const account = await parallelStore.get(binding.accountId).catch(() => undefined);
    if (!account) {
      return;
    }
    await pushBind(tabId);
    await applyTitle(tabId, account.tabName);
  },

  /** SW 冷启动恢复：绑定表 + token/Cookie 快照 → 重建内存态与规则（授权健康门控） */
  async restore(): Promise<void> {
    void diag('parallelSession.restore 开始');
    await readState();
    enforcement.clear();
    const persisted = new Map<number, { host: string; token: string | null; cookie: string | null }>();
    for (const [tabId, b] of bindings) {
      if (await isEnforceable(b.host)) {
        persisted.set(tabId, {
          host: b.host,
          token: tokens.get(b.accountId)?.token ?? null,
          cookie: cookieHeaderOf(b.accountId),
        });
      }
    }
    await tabRules.restore(persisted);
    void diag(`parallelSession.restore 完成 persisted=${persisted.size}`);
  },

  async handleTabRemoved(tabId: number): Promise<void> {
    if (bindings.has(tabId)) {
      await this.unbindTab(tabId);
    }
  },
};

async function tabStillAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** 构造带种子快照的绑定载荷（hello 应答与主动推送共用） */
function buildBindPayload(accountId: string, tabId?: number): BridgeDownPayload {
  const snap = tokens.get(accountId);
  const seed: Record<string, string> = {};
  if (snap?.token) {
    seed['__auth_token__'] = snap.token;
  }
  if (snap?.authUser) {
    seed['__auth_user__'] = snap.authUser;
  }
  if (snap?.deviceFp) {
    seed['__device_fp__'] = snap.deviceFp;
  }
  return { op: 'bind', accountId, tabId, seed };
}

async function pushBind(tabId: number): Promise<void> {
  const binding = bindings.get(tabId);
  if (!binding) {
    return;
  }
  // 携带账号快照作种子：壳激活瞬间即有正确 token/身份，杜绝跨账号读取窗口
  await pushDown(tabId, buildBindPayload(binding.accountId, tabId));
}

async function pushDown(tabId: number, payload: BridgeDownPayload): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: CONTENT_MESSAGE.bridgeDown, payload });
  } catch {
    // 内容脚本未就绪或页面已关闭：onNavigation/loading 事件会再次推送
  }
}

/** 装载事件监听；由 service-worker 调用一次 */
export function registerParallelHandlers(): void {
  void parallelSession.restore();

  chrome.runtime.onStartup?.addListener(() => {
    void parallelSession.restore();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void parallelSession.handleTabRemoved(tabId);
  });

  // 站点自开的新页签：opener 已绑定 → 亲子继承（低代码平台弹窗编辑保持同一账号身份）
  chrome.tabs.onCreated.addListener((tab) => {
    void parallelSession.adoptFromOpener(tab);
  });

  // 导航提交近似信号：status=loading 时重推种子/标题（不引入 webNavigation 权限）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      void parallelSession.onNavigation(tabId);
    }
  });

  // 会话卫生：持续驱逐重入真实 jar 的扩展账号 Cookie（v3.10.2）
  chrome.cookies.onChanged.addListener((change) => {
    void evictJarCookie(change);
  });

  void cleanupStaleBindings();
}

/** 恢复时清理指向已不存在标签页的陈旧绑定 */
async function cleanupStaleBindings(): Promise<void> {
  for (const tabId of Array.from(bindings.keys())) {
    const alive = await tabStillAlive(tabId);
    if (!alive) {
      await parallelSession.handleTabRemoved(tabId);
    }
  }
}
