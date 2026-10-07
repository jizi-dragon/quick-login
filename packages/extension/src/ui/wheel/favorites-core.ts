import { buildRingWheel, type RingItem } from './ring-wheel';

/**
 * 常用页面书签轮盘（v3.16，Alt+1）—— 「通用单环轮盘」在书签上的适配层。
 * 需求来自同事「阿克索配置助手 v2.1.0」评审的 D1（常用页面书签）。
 *
 * 与状态轮盘的区别：没有「当前项」概念，全环同色；悬停预演改成「将打开「名称」」，
 * 让用户在点下去之前确认打开的是哪一条（书签名称相近时尤其有用）。
 */
export interface FavoriteWheelItem {
  name: string;
  path: string;
}

export interface FavoritesWheelOpts {
  favorites: FavoriteWheelItem[];
  /** 基准域名（展示在 Hub 顶行，让用户知道相对路径会拼到哪） */
  baseOrigin: string;
  /** 有值 = 只展示原因，不响应点击（例如一个书签都没有 / 无法确定基准域名） */
  disabledReason?: string;
  onPick: (item: FavoriteWheelItem) => void;
}

export function buildFavoritesWheel(root: HTMLElement, opts: FavoritesWheelOpts): void {
  const n = opts.favorites.length;
  const isAbsolute = (p: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim());
  const host = (() => {
    try {
      return opts.baseOrigin ? new URL(opts.baseOrigin).host : '';
    } catch {
      return '';
    }
  })();

  const defaultSub = opts.disabledReason
    ? opts.disabledReason
    : host
      ? '点选打开 · 数字键 1-9 快选'
      : '点选打开（相对路径需先打开一个平台页面来确定域名）';

  const items: RingItem[] = opts.favorites.map((f) => ({
    key: f.path,
    label: f.name,
  }));

  buildRingWheel(root, {
    items,
    hubTop: host || '常用页面',
    hubMain: n ? `${n} 个书签` : '暂无书签',
    hubSub: n > 10 ? `共 ${n} 个 · 仅显示前 10` : defaultSub,
    empty: {
      cap: '常用页面',
      line1: '还没有任何书签',
      line2: '到并行管理页的「常用页面」里添加',
    },
    onHover: opts.disabledReason
      ? undefined
      : (key) => {
          if (key === null) {
            return { main: `${n} 个书签`, sub: defaultSub };
          }
          const it = opts.favorites.find((f) => f.path === key);
          if (!it) {
            return undefined;
          }
          return {
            main: it.name,
            sub: isAbsolute(it.path) ? '将打开（完整网址）' : `将打开 ${host || '基准域名'}`,
          };
        },
    onPick: (path) => {
      if (opts.disabledReason) {
        return;
      }
      const it = opts.favorites.find((f) => f.path === path);
      if (it) {
        opts.onPick(it);
      }
    },
  });
}
