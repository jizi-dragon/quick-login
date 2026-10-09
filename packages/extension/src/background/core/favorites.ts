/**
 * 常用页面书签（v3.16，Alt+1 轮盘）—— 需求来自同事「阿克索配置助手 v2.1.0」评审的 D1。
 *
 * 与「最近配置页 MRU」（v3.11–v3.15，已在 v3.16 移除）的分工：
 *   MRU = 「我刚去过哪」；书签 = 「我常去哪」。前者按浏览行为自动记录，后者由用户显式维护。
 *
 * 存储：`chrome.storage.local['ql:favorites']`，形如 `[{name, path}]`。
 * 空/缺省 = 用内置默认（`DEFAULT_FAVORITES`，平台常用管理页），这样新用户开箱即用。
 *
 * `path` 允许两种形态：
 *   - 完整网址（`https://x/y`）→ 原样打开；
 *   - 相对路径（`/admin/...`）→ 拼到「基准 origin」上。基准优先级：
 *     本次调用传入的 baseOrigin → 当前活动页签的 origin → 放弃并报错（不猜一个域名）。
 */
import { DEFAULT_FAVORITES, FAVORITES_MAX, LOCAL_KEYS } from '../../shared/constants';
import { getLogger } from '../../shared/log';
import type { FavoriteItem } from '../../shared/messages';

/** ★ 2026-10-09 补：这个模块此前**没有任何日志**，而它的读失败会让用户的收藏静默消失。 */
const log = getLogger('favorites');

function normalizeOne(raw: unknown): FavoriteItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? '').trim();
  const path = String(o.path ?? '').trim();
  if (!name || !path) {
    return null; // 名称与路径缺一不可：没有路径的条目点不动
  }
  return { name, path };
}

/** 读书签；未配置过（或配置全为空）时回落内置默认 */
export async function listFavorites(): Promise<FavoriteItem[]> {
  let stored: unknown;
  try {
    const o = await chrome.storage.local.get(LOCAL_KEYS.favorites);
    stored = o[LOCAL_KEYS.favorites];
  } catch (e) {
    // ★★ 2026-10-09 补：这一支**此前完全静默**，而它的表现是**对用户说谎**。
    //
    //   读失败 ⇒ `stored = undefined` ⇒ 下面回落到 `DEFAULT_FAVORITES`
    //   ⇒ **用户自建的收藏整份不见了，界面上显示的是内置默认书签**。
    //
    //   ★ 用户看到的是"我的书签被换掉了"，而不是"读取失败了" ——
    //     他会以为扩展改了他的数据（而其实一个字节都没动）。
    //     没有这一行时，我们的排查方向会完全错（去查存储写入 / 同步 / 迁移）。
    //
    //   ★ 级别 `warn`：它是降级（数据没坏，只是这次读不出来），不是主流程失败。
    //   ★ 不选 `debug`：默认 `info` 下不输出 ⇒ 等于没加（规则 25）。
    //   ★ 触发频率：`listFavorites` 在轮盘（Alt+1）与管理页被调用，是**用户动作级**
    //     频率，不是热路径 ⇒ 不会挤掉 `ql:diag` 环形 60 里更重要的记录。
    log.warn('listFavorites 读 storage.local 失败 ⇒ 回落到内置默认书签（用户的收藏这次看不到）：%s',
      (e as Error)?.message ?? e);
    stored = undefined;
  }
  const arr = Array.isArray(stored) ? stored : [];
  const items = arr.map(normalizeOne).filter((x): x is FavoriteItem => x !== null);
  const use = items.length ? items : DEFAULT_FAVORITES.map((d) => ({ ...d }));
  // 轮盘一环最多 FAVORITES_MAX 个；超出部分由管理页提示精简（不静默丢弃到无感知）
  return use.slice(0, FAVORITES_MAX);
}

/** 管理页写入（内容脚本侧不写，避免两处各写一份归一化逻辑） */
export async function saveFavorites(items: unknown): Promise<FavoriteItem[]> {
  const arr = Array.isArray(items) ? items : [];
  const clean = arr.map(normalizeOne).filter((x): x is FavoriteItem => x !== null);
  await chrome.storage.local.set({ [LOCAL_KEYS.favorites]: clean });
  return clean;
}

/** 当前活动页签的 origin（用于相对路径书签的基准） */
async function activeOrigin(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      return '';
    }
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

/**
 * 把书签解析成可打开的 URL。
 * 基准缺失时返回 null —— **不猜域名**（猜错会静默打开别人的站点）。
 */
export async function resolveFavoriteUrl(path: string, baseOrigin?: string): Promise<string | null> {
  const raw = String(path ?? '').trim();
  if (!raw) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw;
  }
  let base = String(baseOrigin ?? '').trim();
  if (!base) {
    base = await activeOrigin();
  }
  if (!base) {
    return null;
  }
  try {
    base = new URL(base).origin;
  } catch {
    return null;
  }
  return base + (raw.startsWith('/') ? raw : `/${raw}`);
}
