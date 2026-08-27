/**
 * 账号选择轮盘（扩展弹窗页版本，v2.6 起 / v3.1 视觉重构）。
 * 由 background 在收到 quick-wheel 命令时以独立 popup 窗口打开——
 * 因此在浏览器任何位置（含 chrome:// 页、新标签页）都能唤起，不再依赖向宿主页注入。
 * 失焦自动关闭（带启动宽限）；Esc 关闭；数字键 1-9 快选。
 */
import type { ParallelAccount, ParallelAccountStatus } from '../../shared/types';

type WheelAccount = Pick<ParallelAccount, 'id' | 'tabName' | 'username' | 'color'> & Partial<Partial<ParallelAccountStatus>>;

const wheelEl = document.getElementById('wheel') as HTMLDivElement;
const subEl = document.getElementById('sub') as HTMLParagraphElement;
const PARALLEL_PAGE = chrome.runtime.getURL('ui/parallel/parallel.html');

/* 启动宽限后再武装失焦关闭（创建瞬间可能误触发 blur） */
let blurArmed = false;
window.setTimeout(() => {
  blurArmed = true;
}, 400);
window.addEventListener('blur', () => {
  if (blurArmed) {
    window.close();
  }
});
void window.focus();

document.getElementById('close')!.addEventListener('click', () => window.close());

async function fetchAccounts(): Promise<WheelAccount[]> {
  const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
    | { kind: 'par.list'; result: { ok: boolean; data?: WheelAccount[] } }
    | undefined;
  if (!res?.result?.ok || !Array.isArray(res.result.data)) {
    return [];
  }
  // 在线的排前面，便于快速定位
  return [...res.result.data].sort((a, b) => (b.tabIds?.length ?? 0) - (a.tabIds?.length ?? 0));
}

const WHEEL_W = 360;
const WHEEL_H = 330;

function render(accounts: WheelAccount[]): void {
  wheelEl.innerHTML = '';
  const n = accounts.length;

  /* ---- 空态卡片 ---- */
  if (!n) {
    subEl.textContent = '还没有任何并行账号';
    const card = document.createElement('div');
    card.className = 'empty-card';
    const ico = document.createElement('div');
    ico.className = 'empty-ico';
    ico.textContent = '🗂️';
    const h = document.createElement('h2');
    h.textContent = '暂无并行账号';
    const p = document.createElement('p');
    p.textContent = '添加账号并授权站点后，这里就会显示可切换的身份。';
    const go = document.createElement('button');
    go.textContent = '去并行管理页添加';
    go.addEventListener('click', async () => {
      await chrome.tabs.create({ url: PARALLEL_PAGE });
      window.close();
    });
    card.append(ico, h, p, go);
    wheelEl.append(card);
    requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));
    return;
  }

  const onlineCount = accounts.filter((a) => (a.tabIds?.length ?? 0) > 0).length;
  subEl.innerHTML = '';
  const cnt = document.createElement('span');
  cnt.textContent = `${n} 个账号`;
  subEl.append(cnt);
  if (onlineCount > 0) {
    subEl.append(` · ${onlineCount} 个在线`);
    const dot = document.createElement('i');
    dot.className = 'on-dot';
    subEl.prepend(dot);
    wheelEl.classList.add('has-online');
  }

  /* ---- 椭圆布局参数：账号多时自适应外扩 + 密集模式 ---- */
  const dense = n >= 9;
  if (dense) {
    wheelEl.classList.add('dense');
  }
  const rx = n <= 6 ? 134 : n <= 8 ? 138 : 144;
  const ry = n <= 6 ? 110 : n <= 8 ? 116 : 122;

  const cx = WHEEL_W / 2;
  const cy = WHEEL_H / 2;
  const pts = accounts.map((_, i) => {
    const rad = ((-90 + (360 * i) / n) * Math.PI) / 180;
    return { x: Math.cos(rad) * rx, y: Math.sin(rad) * ry };
  });

  /* ---- 连接线（SVG，精确指向每个节点） ---- */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'links');
  svg.setAttribute('viewBox', `0 0 ${WHEEL_W} ${WHEEL_H}`);
  for (let i = 0; i < n; i++) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(cx));
    line.setAttribute('y1', String(cy));
    line.setAttribute('x2', String(cx + pts[i].x));
    line.setAttribute('y2', String(cy + pts[i].y));
    line.style.setProperty('--d', `${0.12 + i * 0.04}s`);
    svg.append(line);
  }
  wheelEl.append(svg);

  /* ---- 账号节点（错峰弹出入场） ---- */
  for (let i = 0; i < n; i++) {
    const a = accounts[i];
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'node';
    node.style.setProperty('--x', `${pts[i].x}px`);
    node.style.setProperty('--y', `${pts[i].y}px`);
    node.style.setProperty('--d', `${0.12 + i * 0.04}s`);

    const online = (a.tabIds?.length ?? 0) > 0;
    const ring = online ? '#22C55E' : a.color || '#1E6FFF';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.setProperty('--ring', ring);
    avatar.textContent = (a.tabName || a.username).trim().charAt(0).toUpperCase() || '?';

    const dot = document.createElement('i');
    dot.className = online ? 'dot on' : 'dot';
    avatar.append(dot);

    const label = document.createElement('div');
    label.className = 'label';
    if (i < 9) {
      const num = document.createElement('b');
      num.textContent = String(i + 1);
      label.append(num);
    }
    label.append(a.tabName || a.username);

    node.append(avatar, label);
    node.title = a.username === a.tabName || !a.username ? a.tabName || a.username : `${a.tabName || a.username}（${a.username}）`;
    node.addEventListener('click', () => void pick(a.id));
    wheelEl.append(node);
  }

  /* ---- 中心 Hub ---- */
  const hub = document.createElement('div');
  hub.className = 'hub';
  const inner = document.createElement('div');
  inner.className = 'hub-inner';
  const glyph = document.createElement('div');
  glyph.className = 'hub-glyph';
  glyph.textContent = 'Q';
  const b = document.createElement('b');
  b.textContent = '选择账号';
  const s = document.createElement('span');
  s.textContent = onlineCount > 0 ? `${onlineCount}/${n} 在线` : `${n} 个账号`;
  inner.append(glyph, b, s);
  hub.append(inner);
  wheelEl.append(hub);

  /* 双 rAF 确保 初状态 已提交后再触发过渡 */
  requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));
}

async function pick(accountId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ kind: 'par.open', id: accountId });
  } finally {
    window.close();
  }
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.close();
    return;
  }
  const idx = Number(e.key) - 1;
  if (!Number.isNaN(idx) && idx >= 0 && idx < 9) {
    void fetchAccounts().then((accounts) => {
      if (idx < accounts.length) {
        void pick(accounts[idx].id);
      }
    });
  }
});

void fetchAccounts().then(render);
