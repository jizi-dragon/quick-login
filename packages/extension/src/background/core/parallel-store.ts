import { db } from '../../storage/db';
import { SESSION_COLORS } from '../../shared/constants';
import { credentials } from './credentials';
import type { EncryptedCredentials, ParallelAccount } from '../../shared/types';

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 并行账号持久化：页签名 / 账号名 / 加密密码 落 IndexedDB */
export const parallelStore = {
  list(): Promise<ParallelAccount[]> {
    return db.accounts.list();
  },

  async get(id: string): Promise<ParallelAccount> {
    const account = await db.accounts.get(id);
    if (!account) {
      throw new Error(`账号不存在: ${id}`);
    }
    return account;
  },

  async create(input: {
    siteHost: string;
    tabName: string;
    username: string;
    password: string;
    box?: string;
  }): Promise<ParallelAccount> {
    const now = Date.now();
    const existing = await db.accounts.list();
    const box = input.box?.trim();
    const account: ParallelAccount = {
      id: newId(),
      siteHost: input.siteHost,
      tabName: input.tabName || input.username,
      username: input.username,
      color: SESSION_COLORS[existing.length % SESSION_COLORS.length],
      ...(box ? { box } : {}),
      createdAt: now,
      updatedAt: now,
      credentials: await credentials.encryptCredentials(input.username, input.password),
    };
    await db.accounts.put(account);
    return account;
  },

  async updateTabName(id: string, tabName: string): Promise<ParallelAccount> {
    const account = await this.get(id);
    const next: ParallelAccount = { ...account, tabName, updatedAt: Date.now() };
    await db.accounts.put(next);
    return next;
  },

  /** 移入盒子（空串/空白 = 回到「默认盒子」，即移除 box 字段） */
  async updateBox(id: string, box: string): Promise<ParallelAccount> {
    const account = await this.get(id);
    const name = box.trim();
    const next: ParallelAccount = { ...account, updatedAt: Date.now() };
    if (name) {
      next.box = name;
    } else {
      delete next.box;
    }
    await db.accounts.put(next);
    return next;
  },

  async updateCredentials(id: string, creds: EncryptedCredentials): Promise<void> {
    const account = await this.get(id);
    await db.accounts.put({ ...account, credentials: creds, updatedAt: Date.now() });
  },

  async delete(id: string): Promise<void> {
    await db.accounts.delete(id);
  },
};
