import { SESSION_KEYS, CONTENT_MESSAGE } from '../../shared/constants';
import { accountRegistry } from './account-registry';
import { cookieFence } from './isolation/cookie-fence';
import { notifyTabState } from './isolation/storage-fence';
import { setTabTitle } from '../tabs/tab-title';
import { sessionManager } from './session-manager';
import type { Session } from '../../shared/types';

export interface TabBinding {
  sessionId: string;
  host: string;
  lastVisitedUrl?: string;
}

/** 内存 + session 持久化的 tabId ↔ sessionId 绑定表 */
const bindings = new Map<number, TabBinding>();

/**
 * host 的 cookie jar 当前归属的会话（host → sessionId）。
 * 持久化于 storage.session，service-worker 重启后仍可恢复所有权判断。
 * 仅存储真实拥有 jar 的会话；无会话持有该 host 时该键缺席。
 */
let jarOwners = new Map<string, string>();

export function extractHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : null;
  } catch {
    return null;
  }
}

async function readState(): Promise<void> {
  const stored = await chrome.storage.session.get([
    SESSION_KEYS.sessionTabBindings,
    SESSION_KEYS.jarOwners,
  ]);
  const map = stored[SESSION_KEYS.sessionTabBindings] as Record<string, TabBinding> | undefined;
  bindings.clear();
  if (map) {
    for (const [tabId, binding] of Object.entries(map)) {
      bindings.set(Number(tabId), binding);
    }
  }
  const owners = stored[SESSION_KEYS.jarOwners] as Record<string, string> | undefined;
  jarOwners.clear();
  if (owners) {
    for (const [host, sessionId] of Object.entries(owners)) {
      jarOwners.set(host, sessionId);
    }
  }
}

async function persistBindings(): Promise<void> {
  const map: Record<string, TabBinding> = {};
  for (const [tabId, binding] of bindings) {
    map[String(tabId)] = binding;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.sessionTabBindings]: map });
}

async function persistOwners(): Promise<void> {
  const map: Record<string, string> = {};
  for (const [host, sessionId] of jarOwners) {
    map[host] = sessionId;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.jarOwners]: map });
}

/** 纯固话会话态：写入标签标题并下发存储态（不触碰 Cookie） */
async function applySessionUi(tabId: number, binding: TabBinding): Promise<void> {
  const alias = (await accountRegistry.getAlias(binding.sessionId)) ?? '';
  await Promise.all([
    notifyTabState(tabId, binding.sessionId, alias),
    setTabTitle(tabId, alias),
  ]);
}

/** 若指定标签是持有其 host jar 的会话标签，则把当前 jar 固化为该会话快照（保存登录态） */
async function captureIfOwner(tabId: number): Promise<void> {
  const binding = bindings.get(tabId);
  if (!binding) {
    return;
  }
  if (jarOwners.get(binding.host) !== binding.sessionId) {
    return;
  }
  await cookieFence.capture(binding.sessionId, binding.host);
}

/** 若绑定会话不是该 host jar 的当前持有者，则切换所有权并写回其快照；随后应用会话态 */
async function activateIfBound(tabId: number): Promise<void> {
  const binding = bindings.get(tabId);
  if (!binding) {
    return;
  }
  if (jarOwners.get(binding.host) !== binding.sessionId) {
    await cookieFence.switchIn(binding.sessionId, binding.host);
    jarOwners.set(binding.host, binding.sessionId);
    await persistOwners();
  }
  await applySessionUi(tabId, binding);
}

/** 判断会话在目标 host 是否已有有效的登录 Cookie（存在任意非空的 Cookie 即视为有登录态基础） */
function hasCookie(session: Session, host: string): Promise<boolean> {
  return cookieFence.bag(session.id).then((bag) => !!bag && bag.host === host && bag.cookies.length > 0);
}

/** 已绑定标签待自动登录的凭证暂存（tabId → 凭证）。
 * 凭证需被同一标签页的主 frame 与 iframe frame 共同读取（用户名在主 frame、密码常在 iframe），
 * 故采用「只读共享 + 超时清理」而非「取到即消费」。 */
const pendingAutoLogins = new Map<number, { username: string; password: string; at: number }>();
const AUTO_LOGIN_TTL = 60_000;

/** content 脚本（含各 iframe frame）就绪后主动索取凭证；超时视为失效 */
function getPendingAutoLogin(tabId: number): { username: string; password: string } | null {
  const entry = pendingAutoLogins.get(tabId);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.at > AUTO_LOGIN_TTL) {
    pendingAutoLogins.delete(tabId);
    return null;
  }
  return { username: entry.username, password: entry.password };
}

/** 向已绑定标签下发自动登录：先缓存凭证（供内容脚本主动拉取），再尝试即时下发 */
async function triggerAutoLogin(tabId: number, username: string, password: string): Promise<void> {
  pendingAutoLogins.set(tabId, { username, password, at: Date.now() });
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: CONTENT_MESSAGE.autoLogin,
      username,
      password,
    });
  } catch {
    // 内容脚本未就绪，忽略；其就绪后会经 sb:autoLoginRequest 主动拉取凭证
  }
}

/** 查找该会话已打开的标签页（用于复用而非盲目新建） */
function findOpenTab(sessionId: string): { tabId: number; binding: TabBinding } | null {
  for (const [tabId, binding] of bindings) {
    if (binding.sessionId === sessionId) {
      return { tabId, binding };
    }
  }
  return null;
}

export const navigation = {
  async bind(tabId: number, sessionId: string, host: string, lastVisitedUrl?: string): Promise<void> {
    bindings.set(tabId, { sessionId, host, lastVisitedUrl });
    await persistBindings();
  },

  /**
   * 打开会话：优先复用已打开的该会话标签页（而非盲目新建）。
   * 无已开标签才新建，进入 lastVisitedUrl（已登录）或根地址。
   */
  async open(session: Session, url?: string): Promise<{ tabId: number; reused: boolean }> {
    const existing = findOpenTab(session.id);
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      // 复用标签需重新确认为焦点主导，恢复该会话登录态
      await activateIfBound(existing.tabId);
      return { tabId: existing.tabId, reused: true };
    }
    const target = url ?? session.lastVisitedUrl ?? `https://${session.siteHost}`;
    const tab = await chrome.tabs.create({ url: target });
    const tabId = tab.id!;
    await this.bind(tabId, session.id, session.siteHost, target);
    // 新标签即焦点标签，直接按所有权切换并恢复目标会话登录态
    await activateIfBound(tabId);
    return { tabId, reused: false };
  },

  /**
   * 打开会话（复用优先）：
   * 1) 已存在该会话的标签页 → 直接激活复用；
   * 2) 无标签但已有登录 Cookie → 新建并直达 lastVisitedUrl（已登录首页）；
   * 3) 无标签且无 Cookie → 新建到 /login，触发自动填充登录。
   */
  async openOrCreate(
    session: Session,
    credentials?: { username: string; password: string },
  ): Promise<{ tabId: number; sessionId: string; reused: boolean }> {
    // 复用已存在的该会话标签页
    const existing = findOpenTab(session.id);
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      await activateIfBound(existing.tabId);
      return { tabId: existing.tabId, sessionId: session.id, reused: true };
    }
    // 会话已存登录 Cookie：直接进入最后访问地址，无需填表
    if (await hasCookie(session, session.siteHost)) {
      const { tabId } = await this.open(session, session.lastVisitedUrl);
      return { tabId, sessionId: session.id, reused: false };
    }
    // 无登录 Cookie：进入登录页并自动填充提交
    const { tabId } = await this.open(session, `https://${session.siteHost}/login`);
    if (credentials) {
      await triggerAutoLogin(tabId, credentials.username, credentials.password);
    }
    return { tabId, sessionId: session.id, reused: false };
  },

  /** 内容脚本（含 iframe frame）就绪后主动索取自动登录凭证（只读共享，超时失效） */
  getPendingAutoLogin,

  /** 会话关闭时固化登录态，并同步记录最后访问地址（登录成功后的目标页） */
  async captureActiveSession(): Promise<string | null> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      return null;
    }
    const binding = bindings.get(tab.id);
    if (!binding) {
      return null;
    }
    if (jarOwners.get(binding.host) === binding.sessionId) {
      await cookieFence.capture(binding.sessionId, binding.host);
    }
    return binding.sessionId;
  },

  /**
   * 新建会话时，若用户正停留在该站点且 jar 未被任何会话持有（普通已登录浏览），
   * 则把当前登录态捕获为该新建会话的初始 Cookie 包，使重开即自动登录。
   */
  async captureHostJarIfUnowned(sessionId: string, host: string): Promise<void> {
    if (jarOwners.has(host)) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (extractHost(tab?.url) !== host) {
      return;
    }
    await cookieFence.capture(sessionId, host);
  },
};

/** 装载事件监听，由 service-worker 调用一次 */
export function registerNavigationHandlers(): void {
  void readState();
  // service-worker 每次唤醒都重新装载绑定与所有权
  chrome.runtime.onStartup.addListener(() => {
    void readState();
  });

  // 标签在目标 host 内完成导航后，记录最后访问地址供下次直达；同时固化登录态
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') {
      return;
    }
    const binding = bindings.get(tabId);
    if (!binding) {
      return;
    }
    void chrome.tabs.get(tabId).then(async (tab) => {
      const host = extractHost(tab.url);
      if (host !== binding.host || !tab.url) {
        return;
      }
      // 若已持有该 host jar，则把当前登录态固化进会话包
      if (jarOwners.get(binding.host) === binding.sessionId) {
        await cookieFence.capture(binding.sessionId, binding.host);
      }
      binding.lastVisitedUrl = tab.url;
      await persistBindings();
      void sessionManager.updateLastVisitedUrl(binding.sessionId, tab.url).catch(() => null);
    });
  });

  // 焦点仲裁：离场标签保存登录态，进场标签按需切换 Cookie 罐并应用会话态。
  // 注意：此处对 onUpdated 导航**不**做任何 Cookie 操作——
  // 登录/跳转过程中的连续导航不得清空 jar，否则会抹掉刚写入的登录 Cookie。
  // previousTabId 自 Chrome 88 起由 tabs.onActivated 提供（本项目要求 >=110），
  // 类型库版本滞后，显式声明以取用离场标签。
  chrome.tabs.onActivated.addListener(
    (info: { tabId: number; previousTabId?: number }) => {
      if (info.previousTabId !== undefined && info.previousTabId !== -1) {
        void captureIfOwner(info.previousTabId);
      }
      void activateIfBound(info.tabId);
    },
  );

  // 标签关闭：先行固化登录态，再清除绑定与待登录凭证
  chrome.tabs.onRemoved.addListener((tabId) => {
    pendingAutoLogins.delete(tabId);
    void captureIfOwner(tabId).finally(() => {
      if (bindings.delete(tabId)) {
        void persistBindings();
      }
    });
  });
}