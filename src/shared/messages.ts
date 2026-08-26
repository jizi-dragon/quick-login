import type { Session, SiteGrant } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** UI / content ⇄ background 的请求协议 */
export type RuntimeRequest =
  | { kind: 'session.list' }
  | { kind: 'session.get'; id: string }
  | { kind: 'session.create'; input: { name: string; accountAlias: string; siteHost: string } }
  | { kind: 'session.update'; id: string; patch: Partial<Pick<Session, 'name' | 'accountAlias' | 'color'>> }
  | { kind: 'session.delete'; id: string }
  | { kind: 'session.open'; id: string; host: string }
  | { kind: 'session.openOrCreate'; host: string; username?: string; password?: string; accountAlias?: string }
  | { kind: 'session.updateCredentials'; id: string; username: string; password: string }
  | { kind: 'site.grants.list' }
  | { kind: 'site.grant.add'; host: string };

export type RuntimeResponse =
  | { kind: 'session.list'; result: Result<Session[]> }
  | { kind: 'session.get'; result: Result<Session> }
  | { kind: 'session.create'; result: Result<Session> }
  | { kind: 'session.update'; result: Result<Session> }
  | { kind: 'session.delete'; result: Result<void> }
  | { kind: 'session.open'; result: Result<{ tabId: number }> }
  | { kind: 'session.openOrCreate'; result: Result<{ tabId: number; sessionId: string; reused: boolean }> }
  | { kind: 'session.updateCredentials'; result: Result<void> }
  | { kind: 'site.grants.list'; result: Result<SiteGrant[]> }
  | { kind: 'site.grant.add'; result: Result<SiteGrant> };

export type { Result };
