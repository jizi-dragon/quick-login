import { SESSION_COLORS } from '../../shared/constants';
import { cloudStore, fetchPlaintextPassword } from './cloud-store';
import { cacheBelongsTo, loadSnapshot, saveSnapshot } from './account-cache';
import type { ParallelAccount } from '../../shared/types';

/** 新增账号的入参 */
export interface ParallelAccountInput {
  siteHost: string;
  tabName: string;
  username: string;
  password: string;
  box?: string;
  scheme?: 'http' | 'https';
}

/**
 * 数据层门面契约：**这 10 个方法就是全部数据访问面**
 * （调用点只有 `parallel-session` / `service-worker`）。
 *
 * ★ v3.18（2026-10-09）：**本地数据源已整体废除**，这里只剩云端一种实现。
 *   签名一个都没改 —— 调用点一行不用动。
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
  delete(id: string): Promise<void>;
}

/**
 * 离线错误。
 *
 * ★ 单独一个类型是为了让**界面能给出准确的提示**：
 *   "离线，这里是上次的副本，改不了" 与 "服务端 500" 是两件完全不同的事，
 *   而它们都长着同一张 `Error` 的脸。调用点用 `isOfflineError(e)` 判断。
 */
export class OfflineError extends Error {
  readonly code = 'offline';
  readonly isOfflineError = true;
  constructor(action: string) {
    super(`离线：${action}需要连接云端。当前显示的是上次同步的只读副本。`);
    this.name = 'OfflineError';
  }
}

export function isOfflineError(e: unknown): e is OfflineError {
  return Boolean(
    e && typeof e === 'object' && (e as { isOfflineError?: boolean }).isOfflineError === true,
  );
}

/**
 * 读路径：**先云端，失败才回落到只读缓存**。
 *
 * ★ 回落是有条件的，这个条件很重要：只有**网络/超时类**失败才回落。
 *   如果是 401（令牌过期）或 403，回落会让用户看着一份旧数据、
 *   以为"还能用"，从而不去重新登录 —— 那比直接报错更糟。
 *   ⇒ 所以只有 `OfflineError` 才回落，认证类错误原样抛。
 */
async function listWithFallback(): Promise<ParallelAccount[]> {
  try {
    const rows = await cloudStore.list();
    // 成功即**刷新缓存**。这是缓存唯一的写入点。
    void persistSnapshot(rows).catch(() => undefined);
    return rows;
  } catch (e) {
    if (!isOfflineError(e)) {
      throw e;
    }
    const snap = await loadSnapshot();
    if (!snap) {
      throw e; // 没有缓存 ⇒ 离线就是没法用，如实报错
    }
    return snap.accounts as ParallelAccount[];
  }
}

async function persistSnapshot(rows: ParallelAccount[]): Promise<void> {
  // 缓存归属校验需要当前登录邮箱；拿不到就按"本机上次登录"处理（见 account-cache 的注释）
  try {
    const { getCloudAuth } = await import('./cloud-store');
    const auth = await getCloudAuth();
    const snap = await loadSnapshot();
    if (snap && !cacheBelongsTo(snap.meta, auth?.email)) {
      // 换了账号 ⇒ 旧缓存必须先丢，不能把上一个人的列表写成本次快照
      await saveSnapshot(rows, { revision: -1, email: auth?.email });
      return;
    }
    await saveSnapshot(rows, { revision: -1, email: auth?.email });
  } catch {
    /* 缓存写失败不影响主流程 */
  }
}

/**
 * 数据层门面：**只有一个实现（云端）**，外加一条只读离线回落。
 *
 * 写操作（create / update* / renameBox / clearBox / delete / updateCredentials）
 * **一律不回落**：离线时抛出 `OfflineError`，让界面明说"改不了"。
 * 本地假写会让用户以为改成功了，而恢复在线后那份改动**根本不存在** ——
 * 这是被废除的那套方案最坏的一种失败形态。
 */
export const parallelStore: ParallelStore = {
  async list(): Promise<ParallelAccount[]> {
    return listWithFallback();
  },

  async get(id: string): Promise<ParallelAccount> {
    try {
      return await cloudStore.get(id);
    } catch (e) {
      if (!isOfflineError(e)) {
        throw e;
      }
      const snap = await loadSnapshot();
      const hit = snap?.accounts.find((a) => a.id === id);
      if (!hit) {
        throw e;
      }
      return hit as ParallelAccount;
    }
  },

  create(input: ParallelAccountInput): Promise<ParallelAccount> {
    return cloudStore.create(input);
  },

  updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount> {
    return cloudStore.updateScheme(id, scheme);
  },

  updateTabName(id: string, tabName: string): Promise<ParallelAccount> {
    return cloudStore.updateTabName(id, tabName);
  },

  updateBox(id: string, box: string): Promise<ParallelAccount> {
    return cloudStore.updateBox(id, box);
  },

  renameBox(from: string, to: string): Promise<number> {
    return cloudStore.renameBox(from, to);
  },

  clearBox(name: string): Promise<number> {
    return cloudStore.clearBox(name);
  },


  delete(id: string): Promise<void> {
    return cloudStore.delete(id);
  },
};

/**
 * 自动填表要的**明文口令**。
 *
 * v3.18 之后只剩一条路：**当场** `GET /api/accounts/{id}/password` 取一次。
 * 旧方案里那条"解密本地 AES-GCM `credentials`"的路已随本地数据源一起废除 ——
 * 也就是说**口令在本机不再有任何持久化形态**。
 *
 * ★ 判别只看账号自身的 `hasPassword`（服务端快照里带回来的字段），
 *   不看任何"数据源标记" —— 依赖标记会在标记过期时静默返回 null，
 *   表现是"自动填表突然不填了"，是最难查的一类。
 *
 * 取不到返回 `null`（调用方按"无凭证"处理，绝不让它中断 open()）。
 */
export async function resolveAccountPlaintext(
  account: ParallelAccount,
): Promise<{ username: string; password: string } | null> {
  if (!account.hasPassword) {
    return null;
  }
  try {
    const password = await fetchPlaintextPassword(account.id);
    return password ? { username: account.username, password } : null;
  } catch {
    // ★ 离线 / 取不到一律返回 null：**填表失效是设计的一部分**，
    //   不是错误路径。绝不能因为取不到口令就让"打开账号"整个失败。
    return null;
  }
}

/** 供界面用：这份列表是不是离线副本，以及它有多旧。 */
export interface OfflineStatus {
  offline: boolean;
  savedAt?: number;
  ageMs?: number;
  revision?: number;
}

export async function getOfflineStatus(): Promise<OfflineStatus> {
  const snap = await loadSnapshot();
  if (!snap) {
    return { offline: false };
  }
  const ageMs = Date.now() - snap.meta.savedAt;
  // 「旧」的阈值取 10 分钟：短于它的副本与在线的差别对用户不可感
  return ageMs > 10 * 60 * 1000
    ? { offline: true, savedAt: snap.meta.savedAt, ageMs, revision: snap.meta.revision }
    : { offline: false };
}

/** 测试与"退出登录"用：把只读副本也清掉（换账号时**必须**清，见 account-cache）。 */
export async function dropCachedSnapshot(): Promise<void> {
  const { clearSnapshot } = await import('./account-cache');
  await clearSnapshot();
}

export { SESSION_COLORS };
