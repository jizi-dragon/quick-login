import type { Result, RuntimeRequest, RuntimeResponse } from '../shared/messages';
import { CONTENT_MESSAGE } from '../shared/constants';
import { accountRegistry } from './core/account-registry';
import { cookieFence } from './core/isolation/cookie-fence';
import { credentials } from './core/credentials';
import { navigation, registerNavigationHandlers } from './core/navigation';
import { sessionManager } from './core/session-manager';
import { registerAuthHandlers, siteAuth } from './core/site-auth';

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
    case 'session.get':
      return { kind: 'session.get', result: await tryRun(() => sessionManager.getOrThrow(req.id)) };
    case 'session.create': {
      const r = await tryRun(async () => {
        const session = await sessionManager.create(req.input);
        await navigation.captureHostJarIfUnowned(session.id, session.siteHost);
        return session;
      });
      return { kind: 'session.create', result: r };
    }
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
        // 复用已开标签优先；无则直达 lastVisitedUrl / 或自动登录
        let creds: { username: string; password: string } | undefined;
        if (session.credentials) {
          creds = await credentials.decryptCredentials(session.credentials);
        }
        const { tabId } = await navigation.openOrCreate(session, creds);
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
          await navigation.captureHostJarIfUnowned(session.id, session.siteHost);
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

        const { tabId, reused } = await navigation.openOrCreate(session, creds);
        return { tabId, sessionId: session.id, reused };
      });
      return { kind: 'session.openOrCreate', result: r };
    }
    case 'session.updateCredentials': {
      const r = await tryRun(async () => {
        const enc = await credentials.encryptCredentials(req.username, req.password);
        await sessionManager.updateCredentials(req.id, enc);
      });
      return { kind: 'session.updateCredentials', result: r };
    }
    case 'session.updateLastVisitedUrl': {
      const r = await tryRun(async () => {
        await sessionManager.updateLastVisitedUrl(req.id, req.url);
      });
      return { kind: 'session.updateLastVisitedUrl', result: r };
    }
    case 'site.cookieBag.read':
      return { kind: 'site.cookieBag.read', result: await tryRun(() => cookieFence.bag(req.sessionId)) };
    case 'site.grants.list':
      return { kind: 'site.grants.list', result: await tryRun(() => siteAuth.list()) };
    case 'site.grant.add':
      return { kind: 'site.grant.add', result: await tryRun(() => siteAuth.grant(req.host)) };
  }
}

chrome.runtime.onMessage.addListener((req: RuntimeRequest, sender, sendResponse) => {
  // 内部消息：auto-login 内容脚本就绪后主动索取自动登录凭证
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
  void dispatch(req).then(sendResponse);
  return true;
});

registerNavigationHandlers();
registerAuthHandlers();