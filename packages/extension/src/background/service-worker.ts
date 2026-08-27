import type { Result, RuntimeRequest, RuntimeResponse } from '../shared/messages';
import { CONTENT_MESSAGE } from '../shared/constants';
import { accountRegistry } from './core/account-registry';
import { credentials } from './core/credentials';
import { navigation, registerNavigationHandlers } from './core/navigation';
import { sessionManager } from './core/session-manager';
import { registerAuthHandlers, siteAuth } from './core/site-auth';
import { onEngineEvent, sendCommand } from './nm-client';
import type { EngineCommand } from '../../../shared/nm-protocol';

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
      return { kind: 'site.grants.list', result: await tryRun(() => siteAuth.list()) };
    case 'site.grant.add':
      return { kind: 'site.grant.add', result: await tryRun(() => siteAuth.grant(req.host)) };
  }
}

chrome.runtime.onMessage.addListener((req: unknown, sender, sendResponse) => {
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

  // 2. NM 桥：parallel 页通过 runtime 消息向引擎转发指令
  if (req && typeof req === 'object' && (req as { nmBridge?: boolean }).nmBridge) {
    const payload = req as { direction?: string; cmd?: EngineCommand };
    if (payload.direction === 'command') {
      sendResponse({ ok: sendCommand(payload.cmd!) });
      return true;
    }
    sendResponse({ ok: true });
    return true;
  }

  // 3. 普通扩展内部请求
  void dispatch(req as RuntimeRequest).then(sendResponse);
  return true;
});

onEngineEvent((event) => {
  // 广播给所有监听页（P3 的 parallel.html）
  void chrome.runtime.sendMessage({ nmBridge: true, event }).catch(() => undefined);
});

registerNavigationHandlers();
registerAuthHandlers();
