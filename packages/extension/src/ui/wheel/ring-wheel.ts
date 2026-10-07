import { C, R_IN, R_OUT, el, polar, radialText, sectorPath, truncate } from './wheel-core';

/**
 * 通用单环轮盘（v3.16）—— 账号轮盘之外的两块轮盘（实例状态 / 常用页面）共用的渲染内核。
 *
 * 为什么单独抽一层：状态轮盘与书签轮盘除了「数据是什么」，几何、扇区、编号、径向文字、
 * 空态、单元素退化、Hub 三行结构全都一样。复制两份等于把评审里点出的
 * 「同一段逻辑多处维护」问题再制造一遍。
 *
 * 与账号轮盘（`wheel-core.buildSectorWheel`）的关系：共用同一套视觉契约（同 viewBox、
 * 同类名族、同几何常量），但账号轮盘有「盒子分页」这层额外语义，没有并进来。
 *
 * 视觉契约：
 *   svg.sector-svg > g.sector.ring-sector(.is-current)[--acc][--d]
 *                      > path.sector-hit + text.sector-label
 *                      + g.sector-num(circle+text) + circle.sector-dot
 *                  + g.hub > circle.hub-bg + text.hub-box / text.hub-main / text.hub-sub
 *                  （空态）text.hub-cap + text.hub-sub ×2
 */
export const RING_MAX = 10;

export interface RingItem {
  /** 回传给 onPick 的稳定标识 */
  key: string;
  /** 扇区上的文字（内部按 8 字截断） */
  label: string;
  /** 强调色；缺省中性灰蓝。当前项通常给品牌色 */
  accent?: string;
  /** 是否为「当前」项（高亮 + 圆点标记） */
  current?: boolean;
}

export interface RingWheelOpts {
  items: RingItem[];
  /** Hub 顶行（小字标题，如生命周期名 / 「常用页面」） */
  hubTop: string;
  /** Hub 主行（大字，如当前状态名 / 书签数量） */
  hubMain: string;
  /** Hub 底行（操作提示） */
  hubSub: string;
  /** 空态文案（items 为空时使用） */
  empty: { cap: string; line1: string; line2: string };
  /**
   * 悬停预演：返回要替换的 Hub 主行/底行文案；返回 undefined = 不改。
   * 移出（key=null）时同样会被调用，调用方据此还原。
   */
  onHover?: (key: string | null) => { main: string; sub: string } | undefined;
  onPick: (key: string) => void;
}

function fullRing(): string {
  const r = (R_OUT + R_IN) / 2;
  return `M ${C - r} ${C} a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`;
}

/** 在 root 中构建单环轮盘；调用方负责给 root 加 `.in` 触发入场 */
export function buildRingWheel(root: HTMLElement, opts: RingWheelOpts): void {
  root.innerHTML = '';
  root.classList.add('sector-wheel');

  const list = opts.items.slice(0, RING_MAX);
  const n = list.length;
  const svg = el('svg', { class: 'sector-svg', viewBox: '-18 0 596 520' });
  root.append(svg);

  /* ---------------- 空态 ---------------- */
  if (n === 0) {
    svg.append(el('circle', { class: 'hub-bg', cx: C, cy: C, r: R_IN - 6 }));
    const cap = el('text', { class: 'hub-cap', x: C, y: C - 30, 'text-anchor': 'middle' });
    cap.textContent = truncate(opts.empty.cap, 12);
    const l1 = el('text', { class: 'hub-sub', x: C, y: C + 4, 'text-anchor': 'middle' });
    l1.textContent = opts.empty.line1;
    const l2 = el('text', { class: 'hub-sub', x: C, y: C + 30, 'text-anchor': 'middle' });
    l2.textContent = opts.empty.line2;
    svg.append(cap, l1, l2);
    return;
  }

  /* ---------------- Hub 三行（先建，供扇区回调改写） ---------------- */
  const mainText = el('text', {
    class: 'hub-main',
    x: C,
    y: C - 2,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
  }) as SVGTextElement;
  const subText = el('text', { class: 'hub-sub', x: C, y: C + 40, 'text-anchor': 'middle' }) as SVGTextElement;

  const paint = (main: string, sub: string): void => {
    mainText.textContent = main;
    subText.textContent = sub;
  };
  paint(truncate(opts.hubMain, 12), opts.hubSub);

  /* ---------------- 扇区 ---------------- */
  for (let i = 0; i < n; i++) {
    const item = list[i];
    const single = n === 1;
    const a0 = single ? 0 : (360 * i) / n;
    const a1 = single ? 360 : (360 * (i + 1)) / n;
    const mid = single ? 0 : (a0 + a1) / 2;

    const g = el('g', {
      class: `sector ring-sector${item.current ? ' is-current' : ''}`,
      style: `--acc:${item.accent ?? (item.current ? '#1E6FFF' : '#8A94A6')};--d:${(0.06 + i * 0.05).toFixed(2)}s`,
    });
    g.append(el('path', { class: 'sector-hit', d: single ? fullRing() : sectorPath(a0, a1) }));
    g.append(radialText('sector-label', mid, (R_IN + R_OUT) / 2 + 2, truncate(item.label, 8)));

    if (!single) {
      const numAt = polar(R_IN + 24, mid);
      const flip = mid > 90 && mid < 270;
      const numG = el('g', {
        class: 'sector-num',
        transform: `rotate(${flip ? mid + 180 : mid} ${numAt.x} ${numAt.y})`,
      });
      numG.append(el('circle', { cx: numAt.x, cy: numAt.y, r: 11 }));
      const numText = el('text', {
        x: numAt.x,
        y: numAt.y,
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      });
      numText.textContent = String(i < 9 ? i + 1 : 0);
      numG.append(numText);
      g.append(numG);
    }

    if (item.current) {
      const dotAt = polar(R_OUT - 22, mid);
      g.append(el('circle', { class: 'sector-dot on', cx: dotAt.x, cy: dotAt.y, r: 5.5 }));
    }

    g.addEventListener('mouseenter', () => {
      const p = opts.onHover?.(item.key);
      if (p) {
        paint(truncate(p.main, 12), p.sub);
      }
    });
    g.addEventListener('mouseleave', () => {
      const p = opts.onHover?.(null);
      paint(truncate(p?.main ?? opts.hubMain, 12), p?.sub ?? opts.hubSub);
    });
    g.addEventListener('click', () => opts.onPick(item.key));
    svg.append(g);
  }

  /* ---------------- 中心 Hub ---------------- */
  const hub = el('g', { class: 'hub' });
  hub.append(el('circle', { class: 'hub-bg', cx: C, cy: C, r: R_IN - 8 }));
  const cap = el('text', { class: 'hub-box', x: C, y: C - 52, 'text-anchor': 'middle' });
  cap.textContent = truncate(opts.hubTop, 10);
  hub.append(cap, mainText, subText);
  svg.append(hub);
}
