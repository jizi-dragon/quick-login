import { db } from '../../../storage/db';
import type { CookieRecord } from '../../../shared/types';

function trimDot(domain: string): string {
  return domain.startsWith('.') ? domain.slice(1) : domain;
}

function cookieUrl(cookie: Pick<CookieRecord, 'secure' | 'domain' | 'path'>): string {
  const protocol = cookie.secure ? 'https' : 'http';
  const path = cookie.path?.startsWith('/') ? cookie.path : '/';
  return `${protocol}://${trimDot(cookie.domain)}${path}`;
}

function toRecord(c: chrome.cookies.Cookie): CookieRecord {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expirationDate,
    sameSite: c.sameSite,
    storeId: c.storeId,
    session: c.session,
  };
}

/**
 * Cookie-Fence：单 Cookie 罐模型下的会话 Cookie 隔离。
 *
 * 所有权模型：同一 host 的 cookie jar 在任意时刻只属于一个会话（焦点会话）。
 * 关键约束——**绝不在导航过程中清空 Cookie**。登录/跳转是连续的 loading 导航，
 * 若在导航期清 jar 会把刚写入的登录 Cookie 抹掉，导致永远退回登录页。
 *
 * 因此隔离只发生在「所有权切换」这一确定时刻：焦点从一个会话标签切到另一个
 * 会话标签（或新开会话标签）时，先行捕获离场会话的 jar 快照，再擦写目标会话。
 * 纯捕获（capture）与所有权切换（switchIn）分离，供 navigation 按事件驱动调用。
 */
export const cookieFence = {
  /** 纯捕获：把浏览器 jar 中该 host 的现存 Cookie 固化为某会话快照（不擦除 jar） */
  async capture(sessionId: string, host: string): Promise<void> {
    const all = await chrome.cookies.getAll({ domain: host });
    await db.cookieBags.put({
      sessionId,
      host,
      cookies: all.map(toRecord),
      updatedAt: Date.now(),
    });
  },

  /** 清空浏览器 jar 中某 host 的全部 Cookie（仅所有权切换时使用） */
  async eraseHostCookies(host: string): Promise<void> {
    const all = await chrome.cookies.getAll({ domain: host });
    await Promise.all(
      all.map((c) => chrome.cookies.remove({ url: cookieUrl(c), name: c.name }).catch(() => null)),
    );
  },

  /** 将会话 Cookie 包写回浏览器 jar */
  async writeBagToJar(bag: NonNullable<Awaited<ReturnType<typeof db.cookieBags.get>>>): Promise<void> {
    await Promise.all(
      bag.cookies.map((c) =>
        chrome.cookies
          .set({
            url: cookieUrl(c),
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            expirationDate: c.expirationDate,
            sameSite: c.sameSite,
          })
          .catch(() => null),
      ),
    );
  },

  /** 所有权切换：使 jar 完全呈现目标会话的 Cookie 快照（擦除旧残留 → 写回目标包） */
  async switchIn(sessionId: string, host: string): Promise<void> {
    await this.eraseHostCookies(host);
    const bag = await db.cookieBags.get(sessionId);
    if (bag && bag.host === host) {
      await this.writeBagToJar(bag);
    }
  },

  async bag(sessionId: string) {
    return db.cookieBags.get(sessionId);
  },
};