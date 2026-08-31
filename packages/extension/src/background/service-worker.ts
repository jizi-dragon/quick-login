import type { RuntimeRequest, RuntimeResponse, Result } from '../shared/messages';
import type { BridgeUpPayload } from '../shared/types';
import { CONTENT_MESSAGE, EXT_VERSION } from '../shared/constants';
import { accountRegistry } from './core/account-registry';
import { credentials } from './core/credentials';
import { navigation, registerNavigationHandlers } from './core/navigation';
import {
  invalidateEnforcementCache,
  parallelSession,
  registerParallelHandlers,
  warmEnforcementCache,
} from './core/parallel-session';
import { parallelStore } from './core/parallel-store';
import { sessionManager } from './core/session-manager';
import { tabRules } from './core/tab-rules';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(error: unknown): Result<never> {
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function tryRun<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

async function dispatch(req: RuntimeRequest): Promise<RuntimeResponse> {
  switch (req.kind) {
    case 'session.list':
      return { kind: 'session.list', result: await tryRun(() => sessionManager.list()) };
    case 'session.update': {
      const r = await tryRun(() => sessionManager.update(req.id, req.patch));
      if (r.ok) {
        accountRegistry.invalidate(req.id);
      }
      return { kind: 'session.update', result: r };
    }
    case 'session.delete': {
      const r = await tryRun(() => sessionManager.delete(req.id));
      accountRegistry.invalidate(req.id);
      return { kind: 'session.delete', result: r };
    }
    case 'session.open': {
      const r = await tryRun(async () => {
        const session = await sessionManager.getOrThrow(req.id);
        let creds: { username: string; password: string } | undefined;
        if (session.credentials) {
          creds = await credentials.decryptCredentials(session.credentials);
        }
        const { tabId } = await navigation.switchAccount(session, creds);
        return { tabId };
      });
      return { kind: 'session.open', result: r };
    }
    case 'session.openOrCreate': {
      const r = await tryRun(async () => {
        const all = await sessionManager.list();
        const byHost = all.filter((s) => s.siteHost === req.host);

        let session: Awaited<ReturnType<typeof sessionManager.get>>;
        if (req.accountAlias) {
          // 显式指定账号：精确匹配该账号（标签标题）的既有会话，否则视为新账号
          session = byHost.find((s) => (s.accountAlias || s.name) === req.accountAlias);
        } else {
          // 快捷打开（未指定账号）：复用该 host 最近更新的会话
          session = byHost.sort((a, b) => b.updatedAt - a.updatedAt)[0];
        }

        if (!session) {
          session = await sessionManager.create({
            name: req.accountAlias || req.username || req.host,
            accountAlias: req.accountAlias || req.username || req.host,
            siteHost: req.host,
          });
        }

        // 本次带入了明文账号密码：加密持久化，并作为本次自动登录凭证
        let creds: { username: string; password: string } | undefined;
        if (req.username && req.password) {
          await sessionManager.updateCredentials(
            session.id,
            await credentials.encryptCredentials(req.username, req.password),
          );
          creds = { username: req.username, password: req.password };
        } else if (session.credentials) {
          creds = await credentials.decryptCredentials(session.credentials);
        }

        const { tabId, reused } = await navigation.switchAccount(session, creds);
        return { tabId, sessionId: session.id, reused };
      });
      return { kind: 'session.openOrCreate', result: r };
    }
    case 'site.grants.list':
      // v2.4：旧站点清单入口已移除；保留空实现避免旧调用报 unhandled
      return { kind: 'site.grants.list', result: { ok: true, data: [] } };
    case 'site.grant.add':
      return { kind: 'site.grant.add', result: fail('v2.4 起改为在弹窗/并行页直接授权') };
    case 'par.grantChanged': {
      // 授权增撤后由 UI 通知：刷新授权健康缓存（下轮 par.list 生效）
      invalidateEnforcementCache();
      return { kind: 'par.grantChanged', result: ok(true) };
    }
    case 'ql.diag': {
      // SW 上下文原地诊断（台架取证用）：storage.local 读写 / DNR 安装 / 模块内部状态
      const r = await tryRun(async (): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = {};
        try {
          await chrome.storage.local.set({ __qt: Date.now() });
          const v = await chrome.storage.local.get('__qt');
          out.storageWrite = 'OK';
          out.storageRead = Boolean(v['__qt']);
        } catch (e) {
          out.storageErr = e instanceof Error ? e.message : String(e);
        }
        try {
          out.manifestVersion = chrome.runtime.getManifest().version;
        } catch (e) {
          out.manifestErr = e instanceof Error ? e.message : String(e);
        }
        try {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          out.sessionRuleCount = rules.length;
        } catch (e) {
          out.rulesErr = e instanceof Error ? e.message : String(e);
        }
        try {
          await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [
              {
                id: 777001,
                priority: 1,
                action: {
                  type: 'modifyHeaders',
                  requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
                },
                condition: {
                  resourceTypes: ['main_frame'],
                  requestDomains: ['tonbridge-config.aksoegmp.com'],
                  tabIds: [999999],
                },
              } as chrome.declarativeNetRequest.Rule,
            ],
          });
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [777001] });
          out.dnrInSw = 'OK';
        } catch (e) {
          out.dnrInSwErr = e instanceof Error ? e.message : String(e);
        }
        out.parallel = parallelSession.debugState();
        out.tabRules = tabRules.debugState();
        return out;
      });
      return { kind: 'ql.diag', result: r };
    }

    /* ---------------- 浏览器并行账号（纯扩展模式） ---------------- */
    case 'par.list': {
      const r = await tryRun(async () => {
        const list = await parallelStore.list();
        // 预热授权健康缓存（statusOf 同步读取；修复「无绑定账号永远显示离线」）
        await warmEnforcementCache(list.map((a) => a.siteHost));
        return list.map((a) => ({
          ...a,
          ...parallelSession.statusOf(a),
          password: Boolean(a.credentials),
        }));
      });
      return { kind: 'par.list', result: r };
    }
    case 'par.create': {
      const r = await tryRun(async () => {
        const account = await parallelStore.create({
          siteHost: req.siteHost,
          tabName: req.tabName,
          username: req.username,
          password: req.password,
          box: req.box,
        });
        if (req.open) {
          await parallelSession.open(account.id, false);
        }
        return account;
      });
      return { kind: 'par.create', result: r };
    }
    case 'par.moveBox': {
      const r = await tryRun(() => parallelStore.updateBox(req.id, req.box));
      return { kind: 'par.moveBox', result: r };
    }
    case 'par.update': {
      const r = await tryRun(async () => {
        const account = await parallelStore.updateTabName(req.id, req.patch.tabName ?? '');
        await parallelSession.refreshTitle(req.id);
        return account;
      });
      return { kind: 'par.update', result: r };
    }
    case 'par.delete': {
      const r = await tryRun(() => parallelSession.deleteAccount(req.id));
      return { kind: 'par.delete', result: r };
    }
    case 'par.open': {
      const r = await tryRun(() => parallelSession.open(req.id, req.forceNewTab === true));
      return { kind: 'par.open', result: r };
    }
    case 'wheel.toggle': {
      const r = await tryRun(async () => {
        await toggleAccountWheel();
        return { opened: wheelWinId !== null };
      });
      return { kind: 'wheel.toggle', result: r };
    }
  }
}

chrome.runtime.onMessage.addListener((req: unknown, sender, sendResponse) => {
  // 0. shield 桥上行：绑定查询 / token 捕获上报（先于通用分流）
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === CONTENT_MESSAGE.bridgeUp
  ) {
    const payload = (req as { payload?: BridgeUpPayload }).payload;
    void parallelSession
      .handleBridge(payload as BridgeUpPayload, sender.tab?.id)
      .then(sendResponse);
    return true;
  }

  // 1. auto-login 内容脚本就绪后主动索取自动登录凭证
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === CONTENT_MESSAGE.autoLoginRequest
  ) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse(null);
      return true;
    }
    void navigation.getPendingAutoLogin(tabId).then((creds) => sendResponse(creds));
    return true;
  }

  // 2. （已移除）旧版本地引擎 NM 桥 —— v2.4 起纯浏览器模式，不再转发引擎指令

  // 3. 普通扩展内部请求
  void dispatch(req as RuntimeRequest).then(sendResponse);
  return true;
});

/* ---------------- 快捷键：账号选择轮盘（v3.8：扇形环；页面内无框浮层优先） ---------------- */

const WHEEL_PAGE = 'ui/wheel/wheel.html';
const WHEEL_W = 720;
const WHEEL_H = 760;
/** 兜底浮层脚本（ISOLATED world，幂等开关）：普通网页上直接铺开无框轮盘 */
const WHEEL_OVERLAY_FILE = 'content/wheel-overlay.js';

/** 会话内记忆轮盘窗口 id；再次触发快捷键 = 关闭（幂等开关，仅对独立小窗模式有效） */
let wheelWinId: number | null = null;
/** 触发去抖：命令重放/系统连击不会开后又立刻关 */
let lastToggleAt = 0;

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === wheelWinId) {
    wheelWinId = null;
  }
});

async function toggleAccountWheel(): Promise<void> {
  const now = Date.now();
  if (now - lastToggleAt < 300) {
    return;
  }
  lastToggleAt = now;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  // 机制一（主）：普通网页 → 页面内无框浮层（再次触发 = 脚本自关闭）
  try {
    if (tab?.id && tab.url && /^https?:/i.test(tab.url)) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [WHEEL_OVERLAY_FILE],
        world: 'ISOLATED',
      });
      return;
    }
  } catch {
    // 注入失败（受限页/权限收回等）→ 继续降级
  }

  // 机制二：独立弹窗小窗（Chrome 对 chrome:// 等页注入不了时仍可用）
  if (wheelWinId !== null) {
    try {
      await chrome.windows.get(wheelWinId);
    } catch {
      wheelWinId = null;
    }
    if (wheelWinId !== null) {
      await chrome.windows.remove(wheelWinId).catch(() => undefined);
      wheelWinId = null;
      return;
    }
  }

  const current = tab ? await chrome.windows.get(tab.windowId).catch(() => undefined) : undefined;
  const left =
    current && typeof current.left === 'number'
      ? Math.max(0, current.left + Math.max(0, ((current.width ?? 900) - WHEEL_W) >> 1))
      : undefined;
  const top =
    current && typeof current.top === 'number'
      ? Math.max(0, current.top + Math.max(0, ((current.height ?? 700) - WHEEL_H) >> 1))
      : undefined;

  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(WHEEL_PAGE),
      type: 'popup',
      width: WHEEL_W,
      height: WHEEL_H,
      left,
      top,
    });
    wheelWinId = win.id ?? null;
    return;
  } catch {
    // 继续走最终兜底
  }

  // 机制三（最终）：普通标签页打开轮盘
  await chrome.tabs.create({ url: chrome.runtime.getURL(WHEEL_PAGE) });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-wheel') {
    // 角标闪标：证明命令确实到达了当前版本的后台（现场诊断手段）
    void flashBadge('→');
    void toggleAccountWheel();
  }
});

/** 角标临时显示文本后恢复 */
async function flashBadge(text: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#1E6FFF' });
    await chrome.action.setBadgeText({ text });
    window.setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
    }, 1200);
  } catch {
    // 角标不可用忽略
  }
}

registerNavigationHandlers();
registerParallelHandlers();

/* 启动即短显版本号：重新加载扩展后，无需打开任何界面即可确认新代码已生效 */
void flashBadge(`v${EXT_VERSION.split('.').slice(0, 2).join('.')}`).finally(() => {
  // flashBadge 自身 1.2s 后清空；这里把启动展示延长为额外一次，共约 2.4s 可见窗口
});
