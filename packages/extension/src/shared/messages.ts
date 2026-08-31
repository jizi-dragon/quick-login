import type { ParallelAccount, ParallelAccountStatus, Session, SiteGrant } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** UI / content ⇄ background 的请求协议 */
export type RuntimeRequest =
  | { kind: 'session.list' }
  | { kind: 'session.update'; id: string; patch: Partial<Pick<Session, 'name' | 'accountAlias' | 'color'>> }
  | { kind: 'session.delete'; id: string }
  | { kind: 'session.open'; id: string; host: string }
  | { kind: 'session.openOrCreate'; host: string; username?: string; password?: string; accountAlias?: string }
  | { kind: 'site.grants.list' }
  | { kind: 'site.grant.add'; host: string }
  | { kind: 'par.list' }
  | { kind: 'par.create'; siteHost: string; tabName: string; username: string; password: string; open: boolean; box?: string }
  | { kind: 'par.update'; id: string; patch: Partial<Pick<ParallelAccount, 'tabName'>> }
  | { kind: 'par.moveBox'; id: string; box: string }
  | { kind: 'par.delete'; id: string }
  | { kind: 'par.open'; id: string; forceNewTab?: boolean }
  | { kind: 'par.grantChanged' }
  | { kind: 'ql.diag' }
  | { kind: 'wheel.toggle' };

export type RuntimeResponse =
  | { kind: 'session.list'; result: Result<Session[]> }
  | { kind: 'session.update'; result: Result<Session> }
  | { kind: 'session.delete'; result: Result<void> }
  | { kind: 'session.open'; result: Result<{ tabId: number }> }
  | { kind: 'session.openOrCreate'; result: Result<{ tabId: number; sessionId: string; reused: boolean }> }
  | { kind: 'site.grants.list'; result: Result<SiteGrant[]> }
  | { kind: 'site.grant.add'; result: Result<SiteGrant> }
  | { kind: 'par.list'; result: Result<Array<ParallelAccount & ParallelAccountStatus & { password: boolean }>> }
  | { kind: 'par.create'; result: Result<ParallelAccount> }
  | { kind: 'par.update'; result: Result<ParallelAccount> }
  | { kind: 'par.moveBox'; result: Result<ParallelAccount> }
  | { kind: 'par.delete'; result: Result<void> }
  | { kind: 'par.open'; result: Result<{ tabId: number; reused: boolean }> }
  | { kind: 'par.grantChanged'; result: Result<boolean> }
  | { kind: 'ql.diag'; result: Result<Record<string, unknown>> }
  | { kind: 'wheel.toggle'; result: Result<{ opened: boolean }> };

export type { Result };
