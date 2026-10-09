import { db } from '../../storage/db';
import type { ParallelAccount } from '../../shared/types';

/**
 * 离线**只读**账号缓存（v3.18：废除本地数据源之后的"离线可用"折中）。
 *
 * # 它是什么、不是什么
 *
 * | | 旧的本地数据源（已删） | 本缓存 |
 * |---|---|---|
 * | 口令 | AES-GCM 密文落在 IndexedDB | **一个字节都不存** |
 * | 可写 | 可以新增/编辑/删除 | **只读**（写一律走云端） |
 * | 角色 | 一个独立的账号库 | 云端快照的**只读副本** |
 * | 离线时 | 完整可用（含填表） | 可看、可开页签；**不可新增/编辑，填表失效** |
 *
 * # 为什么必须"一个字节都不存"
 *
 * 旧方案的密文是 AES-GCM，密钥派生自 `chrome.storage.local` 里的随机种子 ——
 * 也就是说**密钥和密文在同一台机器的同一个扩展里**。它防的是"IndexedDB 被单独读到"
 * （几乎不存在的威胁），防不了"扩展数据目录被整份拿走"（这才是真威胁）。
 * 废除它的理由不是"加密不够强"，而是**它让口令出现在两个地方** ——
 * 而云端那份是 Fernet 加密、由服务端持有密钥，责任边界清楚得多。
 *
 * # 为什么用 IndexedDB 而不是 `chrome.storage.local`
 *
 * `storage.local` 有 10MB 配额（`unlimitedStorage` 权限可以解除，但为一个可丢弃的
 * 缓存去要新权限不划算）；而 IndexedDB 没有这个限制，且 `accounts` 对象仓**本来就在**
 * ——它原来存的就是本地账号，现在改存只读快照。**对象仓名字沿用、语义换掉**，
 * 并借版本升级把旧的（带口令的）数据清干净（见 `storage/db.ts` 的 `onupgradeneeded`）。
 *
 * # 为什么缓存要记 `revision`
 *
 * 服务端 `GET /api/vault/snapshot` 会回 `revision`（单调递增）。缓存记下它，
 * 界面上就能给出**准确的离线提示**（"这是 3 天前的副本"而不是含糊的"可能是旧的"），
 * 而且恢复在线后能立刻判断"我手里的副本是不是已经落后了"。
 */

/** 缓存里存的一行账号：**刻意不含 `credentials`**，也不含任何可解密的口令材料。 */
export type CachedAccount = Omit<ParallelAccount, 'credentials'>;

export interface CacheMeta {
  /** 写入时刻（毫秒） */
  savedAt: number;
  /** 服务端快照的 `revision`（没有就是 -1：老服务端） */
  revision: number;
  /** 条数冗余存一份，便于"列表与元数据是否配套"的自检 */
  count: number;
  /** 产生这份快照的用户邮箱（换账号登录时据此判断缓存该不该丢） */
  email?: string;
}

export interface CacheSnapshot {
  accounts: CachedAccount[];
  meta: CacheMeta;
}

const META_KEY = 'ql:cacheMeta';

/** 读缓存。**任何异常都当作"没有缓存"** —— 缓存损坏不该让扩展起不来。 */
export async function loadSnapshot(): Promise<CacheSnapshot | null> {
  try {
    const stored = await chrome.storage.local.get(META_KEY);
    const meta = stored[META_KEY] as CacheMeta | undefined;
    if (!meta || typeof meta.savedAt !== 'number') {
      return null;
    }
    const accounts = (await db.accounts.list()) as CachedAccount[];
    if (!Array.isArray(accounts)) {
      return null;
    }
    // ★ 自检：条数对不上说明中途崩过（或有人只写了一半）⇒ 当作没有缓存，
    //   而不是把一份"看起来有 12 条、其实元数据说 30 条"的东西交给界面。
    if (accounts.length !== meta.count) {
      return null;
    }
    return { accounts, meta };
  } catch {
    return null;
  }
}

/**
 * 写缓存。**先写账号、再写元数据** —— 顺序不能反：
 * 元数据里带 `count` 作为"写完了"的标记，反过来的话崩在中间会留下一份
 * "元数据说有 30 条、账号只写了 12 条"的缓存，而 `loadSnapshot` 的自检会把它丢掉，
 * 于是**每次启动都白写一遍**（表现是"离线缓存永远建立不起来"）。
 */
export async function saveSnapshot(
  accounts: ParallelAccount[],
  meta: { revision: number; email?: string },
): Promise<void> {
  // ★ v3.18：`ParallelAccount` 已不含 `credentials`，所以这里是**恒等映射** ——
//   保留这行是为了让类型收窄（`ParallelAccount[]` → `CachedAccount[]`）显式可见：
//   哪天 `ParallelAccount` 又长出凭据字段，这一行会**编译不过**，比默默漏掉好。
  const rows: CachedAccount[] = accounts;
  await db.accounts.replaceAll(rows);
  await chrome.storage.local.set({
    [META_KEY]: {
      savedAt: Date.now(),
      revision: meta.revision,
      count: rows.length,
      email: meta.email,
    } satisfies CacheMeta,
  });
}

export async function clearSnapshot(): Promise<void> {
  await db.accounts.replaceAll([]);
  await chrome.storage.local.remove(META_KEY);
}

/**
 * 这份缓存能不能给"当前登录的这个账号"用。
 *
 * ★ 换账号登录时必须丢缓存：否则 A 退出、B 登录、而 B 离线时
 * **看到的是 A 的账号列表**。这是"零共享"在客户端这一侧的对应要求。
 */
export function cacheBelongsTo(meta: CacheMeta, email: string | undefined): boolean {
  if (!email) {
    // 拿不到当前邮箱（未登录/离线）⇒ 无法判断归属。
    // ★ 这种情况下**给用**：离线场景本来就是为了"没登录也能看"，
    //   而缓存内容只可能来自本机上一次成功的登录。
    return true;
  }
  return !meta.email || meta.email === email;
}
