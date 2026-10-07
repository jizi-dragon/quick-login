import { buildRingWheel, type RingItem } from './ring-wheel';

/**
 * 状态轮盘（v3.15，Alt+W）—— 「通用单环轮盘」在实例状态上的适配层。
 *
 * 语义（相对通用内核的增量）：
 *  - 扇区 = 生命周期状态；**当前状态**用品牌色高亮 + 圆点；
 *  - 悬停预演：Hub 主行换成目标状态名、底行换成「将把「当前」改为「X」」（v3.15 的交互约定：
 *    点即执行，但先把后果说清楚）；
 *  - 状态名普遍 2–4 字，超 8 字截断由内核统一处理。
 */
export interface StatusWheelItem {
  id: string;
  code: string;
  name: string;
  isCurrent: boolean;
}

export interface StatusWheelOpts {
  statuses: StatusWheelItem[];
  /** Hub 顶行：生命周期名（更稳定），缺省退到实例名 */
  lifecycleName: string;
  /** 实例 / 对象展示名（空态用） */
  instanceLabel: string;
  /** 有值 = 只展示原因，不响应点击（例如缺 instanceId） */
  disabledReason?: string;
  onPick: (item: StatusWheelItem) => void;
}

export function buildStatusWheel(root: HTMLElement, opts: StatusWheelOpts): void {
  const current = opts.statuses.find((s) => s.isCurrent);
  const currentName = current?.name ?? '';
  const defaultSub = opts.disabledReason
    ? opts.disabledReason
    : currentName
      ? '点选切换状态 · 数字键 1-9 快选'
      : '点选切换状态（当前状态未知）· 数字键快选';

  const items: RingItem[] = opts.statuses.map((s) => ({
    key: s.code,
    label: s.name,
    current: s.isCurrent,
  }));

  buildRingWheel(root, {
    items,
    hubTop: opts.lifecycleName || opts.instanceLabel || '当前实例',
    hubMain: currentName || '未知',
    hubSub: defaultSub,
    empty: {
      cap: opts.instanceLabel || '当前页面',
      line1: opts.disabledReason || '没有读到可切换的状态',
      line2: opts.disabledReason ? '请切到对象实例页再试' : '可能是当前账号无权查看该生命周期',
    },
    onHover: opts.disabledReason
      ? undefined
      : (key) => {
          if (key === null) {
            return { main: currentName || '未知', sub: defaultSub };
          }
          const it = opts.statuses.find((s) => s.code === key);
          if (!it) {
            return undefined;
          }
          return {
            main: it.name,
            sub: `将把「${currentName || '当前'}」改为「${it.name}」`,
          };
        },
    onPick: (code) => {
      if (opts.disabledReason) {
        return;
      }
      const it = opts.statuses.find((s) => s.code === code);
      if (it) {
        opts.onPick(it);
      }
    },
  });
}
