import { db } from '../../storage/db';
import { SESSION_COLORS } from '../../shared/constants';
import { credentials } from './credentials';
import { cloudStore, fetchPlaintextPassword, getDataSource } from './cloud-store';
import type { EncryptedCredentials, ParallelAccount } from '../../shared/types';

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 新增账号的入参（本地/云端两套实现共用同一形状） */
export interface ParallelAccountInput {
  siteHost: string;
  tabName: string;
  username: string;
  password: string;
  box?: string;
  scheme?: 'http' | 'https';
}

/**
 * 数据层门面契约：**这 10 个方法就是全部数据访问面**（调用点只有 parallel-session /
 * service-worker）。本地与云端两套实现都必须逐方法同形 ——
 * 改这里的签名 = 改契约，调用点会当场编译不过（`cloudStoreContract` 是编译期同形证明）。
 */
export interface ParallelStore {
  list(): Promise<ParallelAccount[]>;
  get(id: string): Promise<ParallelAccount>;
  create(input: ParallelAccountInput): Promise<ParallelAccount>;
  updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount>;
  updateTabName(id: string, tabName: string): Promise<ParallelAccount>;
  updateBox(id: string, box: string): Promise<ParallelAccount>;
  renameBox(from: string, to: string): Promise<number>;
  clearBox(name: string): Promise<number>;
  updateCredentials(id: string, creds: EncryptedCredentials): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * 【本地实现 —— v3.14 数据源切换时**一字未动**】
 * 并行账号持久化：页签名 / 账号名 / 加密密码 落 IndexedDB。
 * 切到云端后这里不再被调用，但 IndexedDB 里的数据原样躺着，切回本地立刻可用。
 */
const localStore: ParallelStore = {
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
    scheme?: 'http' | 'https';
  }): Promise<ParallelAccount> {
    const now = Date.now();
    const existing = await db.accounts.list();
    const box = input.box?.trim();
    const account: ParallelAccount = {
      id: newId(),
      siteHost: input.siteHost,
      ...(input.scheme ? { scheme: input.scheme } : {}),
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

  /** 打开失败自学习（v3.10.9）：scheme 翻转写回账号档案 */
  async updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount> {
    const account = await this.get(id);
    const next: ParallelAccount = { ...account, scheme, updatedAt: Date.now() };
    await db.accounts.put(next);
    return next;
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

  /** 盒子重命名：盒内账号随迁；to 为空 = 并入「默认盒子」。返回随迁账号数 */
  async renameBox(from: string, to: string): Promise<number> {
    const fromName = from.trim();
    const toName = to.trim();
    if (!fromName) {
      throw new Error('源盒子名为空');
    }
    if (fromName === toName) {
      return 0;
    }
    const accounts = await db.accounts.list();
    let moved = 0;
    for (const account of accounts) {
      if ((account.box ?? '').trim() !== fromName) {
        continue;
      }
      const next: ParallelAccount = { ...account, updatedAt: Date.now() };
      if (toName) {
        next.box = toName;
      } else {
        delete next.box;
      }
      await db.accounts.put(next);
      moved++;
    }
    return moved;
  },

  /** 删除盒子：盒内账号全部回到「默认盒子」。返回随迁账号数 */
  async clearBox(name: string): Promise<number> {
    return this.renameBox(name, '');
  },

  async updateCredentials(id: string, creds: EncryptedCredentials): Promise<void> {
    const account = await this.get(id);
    await db.accounts.put({ ...account, credentials: creds, updatedAt: Date.now() });
  },

  async delete(id: string): Promise<void> {
    await db.accounts.delete(id);
  },
};

/* ==================== 数据源分发（v3.14：本地 ↔ 云端） ==================== */

async function isCloud(): Promise<boolean> {
  return (await getDataSource()) === 'cloud';
}

/**
 * 数据层门面：按当前数据源分发。
 * - **签名与语义与改动前完全一致**，10 个方法一个不多一个不少；
 *   调用点（parallel-session / service-worker）一行都不用改。
 * - 云端出错时**原样抛出**（"云端不可用：网络请求失败"这类可读错误直达界面），
 *   绝不静默回落本地 —— 那会让用户以为在看云端数据，实际却是本地旧数据。
 */
export const parallelStore: ParallelStore = {
  async list(): Promise<ParallelAccount[]> {
    return (await isCloud()) ? cloudStore.list() : localStore.list();
  },

  async get(id: string): Promise<ParallelAccount> {
    return (await isCloud()) ? cloudStore.get(id) : localStore.get(id);
  },

  async create(input: ParallelAccountInput): Promise<ParallelAccount> {
    return (await isCloud()) ? cloudStore.create(input) : localStore.create(input);
  },

  async updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount> {
    return (await isCloud()) ? cloudStore.updateScheme(id, scheme) : localStore.updateScheme(id, scheme);
  },

  async updateTabName(id: string, tabName: string): Promise<ParallelAccount> {
    return (await isCloud()) ? cloudStore.updateTabName(id, tabName) : localStore.updateTabName(id, tabName);
  },

  async updateBox(id: string, box: string): Promise<ParallelAccount> {
    return (await isCloud()) ? cloudStore.updateBox(id, box) : localStore.updateBox(id, box);
  },

  async renameBox(from: string, to: string): Promise<number> {
    return (await isCloud()) ? cloudStore.renameBox(from, to) : localStore.renameBox(from, to);
  },

  async clearBox(name: string): Promise<number> {
    return (await isCloud()) ? cloudStore.clearBox(name) : localStore.clearBox(name);
  },

  async updateCredentials(id: string, creds: EncryptedCredentials): Promise<void> {
    return (await isCloud()) ? cloudStore.updateCredentials(id, creds) : localStore.updateCredentials(id, creds);
  },

  async delete(id: string): Promise<void> {
    return (await isCloud()) ? cloudStore.delete(id) : localStore.delete(id);
  },
};

/**
 * 自动填表要的**明文口令**（门面之外的附加能力，不改上面 10 个方法）：
 * - 本地：解密账号里的 AES-GCM `credentials`（与改动前同一条路）；
 * - 云端：`credentials` 恒为空（服务端用 Fernet 存，扩展拿不到密文），
 *   当场 `GET /api/accounts/{id}/password` 取明文 —— 只在"打开账号"这一刻取一次。
 *
 * ★ 判别只看**账号自身的形状**（`credentials` 还是 `hasPassword`），不看数据源标记：
 *   云端账号的 `hasPassword` 只有云端 store 会写，而依赖标记会在"切源途中/标记过期"
 *   时静默返回 null（表现是"自动填表突然不填了"，最难查的一类）。
 *
 * 取不到返回 `null`（调用方按"无凭证"处理，绝不让它中断 open()）。
 */
export async function resolveAccountPlaintext(
  account: ParallelAccount,
): Promise<{ username: string; password: string } | null> {
  if (account.credentials) {
    return credentials.decryptCredentials(account.credentials);
  }
  if (account.hasPassword) {
    const password = await fetchPlaintextPassword(account.id);
    return password ? { username: account.username, password } : null;
  }
  return null;
}
