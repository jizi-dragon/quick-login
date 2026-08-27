/**
 * Wheel Overlay —— 快捷键轮盘的「页面内浮层」主机制（v3.2：与独立窗版同款视觉）。
 * background 对当前 https 标签页 executeScript 注入本脚本；再次注入 = 关闭（幂等开关）。
 * Shadow DOM 完全隔离宿主页样式；打开期间锁滚动、聚焦遮罩，数字键不干扰页面输入。
 */
import type { ParallelAccount, ParallelAccountStatus } from '../shared/types';

type WheelAccount = Pick<ParallelAccount, 'id' | 'tabName' | 'username' | 'color'> &
  Partial<Partial<ParallelAccountStatus>>;

const WIN = window as typeof window & { __QL_WHEEL_ACTIVE__?: boolean };
const PARALLEL_PAGE = chrome.runtime.getURL('ui/parallel/parallel.html');

/* 再次注入 = 关闭 */
if (WIN.__QL_WHEEL_ACTIVE__) {
  closeExisting();
} else {
  void mount();
}

function closeExisting(): void {
  const prev = document.getElementById('ql-wheel-overlay-host') as HTMLDivElement | null;
  if (prev) {
    prev.dataset.forceClose = '1';
    prev.dispatchEvent(new CustomEvent('ql-wheel-close'));
    prev.remove();
  }
  document.documentElement.style.removeProperty('overflow');
  WIN.__QL_WHEEL_ACTIVE__ = false;
}

async function fetchAccounts(): Promise<WheelAccount[]> {
  const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
    | { kind: 'par.list'; result: { ok: boolean; data?: WheelAccount[] } }
    | undefined;
  return res?.result?.ok && Array.isArray(res.result.data) ? res.result.data : [];
}

const PANEL_W = 392;
const PANEL_H = 356;
const WHEEL_W = 360;
const WHEEL_H = 296;

async function mount(): Promise<void> {
  const accounts = [...(await fetchAccounts())].sort(
    (a, b) => (b.tabIds?.length ?? 0) - (a.tabIds?.length ?? 0),
  );

  /* ---------- 宿主节点与 Shadow 根 ---------- */
  const host = document.createElement('div');
  host.id = 'ql-wheel-overlay-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { margin:0; padding:0; box-sizing:border-box; font-family: system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
    :host {
      position:fixed; inset:0; z-index:2147483646;
      display:flex; align-items:center; justify-content:center;
      background:rgba(9,14,28,.42);
      backdrop-filter:blur(3px);
      opacity:0; transition:opacity .18s ease;
    }
    :host(.show){opacity:1}

    .panel{
      position:relative; width:${PANEL_W}px; max-width:min(92vw,${PANEL_W}px);
      border-radius:22px; padding:0 0 10px;
      background:
        radial-gradient(120% 80% at 50% -8%, #eef3ff 0%, rgba(238,243,255,0) 55%),
        linear-gradient(180deg,#f8faff,#f1f5ff);
      box-shadow: 0 30px 70px rgba(6,12,32,.45), 0 4px 14px rgba(6,12,32,.25), inset 0 0 0 1px #fff8;
      transform:scale(.88) translateY(14px); transition:transform .26s cubic-bezier(.22,1.4,.36,1);
      overflow:hidden;
    }
    :host(.show) .panel{transform:none}
    .head{text-align:center;padding:16px 16px 2px}
    .head h1{margin:0;font-size:15px;font-weight:700;color:#0f172a;letter-spacing:.02em}
    .sub{margin:3px 0 0;font-size:11px;color:#64748b}
    .sub .on-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#22c55e;margin-right:4px;vertical-align:1px;box-shadow:0 0 6px rgba(34,197,94,.7)}
    .close-btn{position:absolute;top:10px;right:10px;width:26px;height:26px;border:none;border-radius:50%;background:rgba(15,23,42,.05);color:#64748b;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,transform .15s;z-index:5}
    .close-btn:hover{background:#fee2e2;color:#dc2626;transform:rotate(90deg)}

    .stage{display:flex;align-items:center;justify-content:center;height:${PANEL_H}px}
    .wheel{position:relative;width:${WHEEL_W}px;height:${WHEEL_H}px}
    .links{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
    .links line{stroke:rgba(30,111,255,.3);stroke-width:1.6;stroke-linecap:round;opacity:0;transition:opacity .4s ease;transition-delay:calc(var(--d) + .08s)}
    .wheel.in .links line{opacity:1}

    .hub{position:absolute;left:50%;top:50%;translate:-50% -50%;width:104px;height:104px;border-radius:50%;padding:3px;
      background:conic-gradient(from 210deg,#1e6fff,#22c55e,#7c5cff,#1e6fff);
      box-shadow:0 14px 32px rgba(30,111,255,.28),0 2px 8px rgba(15,23,42,.08);z-index:3;
      scale:.5;opacity:0;transition:scale .42s cubic-bezier(.22,1.4,.36,1) .12s,opacity .25s ease .12s}
    .wheel.in .hub{scale:1;opacity:1}
    .hub-inner{width:100%;height:100%;border-radius:50%;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center}
    .hub-glyph{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#1e6fff,#7c5cff);color:#fff;font-size:13px;font-weight:800;line-height:28px;box-shadow:0 4px 10px rgba(30,111,255,.35)}
    .hub b{font-size:12px;color:#0f172a;letter-spacing:.03em}
    .hub span{font-size:10px;color:#64748b}
    .has-online .hub::after{content:'';position:absolute;inset:-4px;border-radius:50%;border:2px solid rgba(34,197,94,.45);animation:breathe 2.4s ease-in-out infinite;pointer-events:none}
    @keyframes breathe{0%,100%{transform:scale(1);opacity:.9}50%{transform:scale(1.07);opacity:.25}}

    .node{position:absolute;left:50%;top:50%;width:118px;margin-left:-59px;margin-top:-42px;display:flex;flex-direction:column;align-items:center;gap:5px;padding:0;background:none;border:none;cursor:pointer;z-index:2;translate:0 0;scale:.3;opacity:0;
      transition:translate .42s cubic-bezier(.22,1.4,.36,1),scale .42s cubic-bezier(.22,1.4,.36,1),opacity .2s ease;transition-delay:var(--d)}
    .wheel.in .node{translate:var(--x) var(--y);scale:1;opacity:1}
    .node:hover{z-index:4}
    .avatar{position:relative;width:52px;height:52px;border-radius:50%;border:2.5px solid var(--ring);background:#fff;color:var(--ring);font-size:18px;font-weight:800;display:flex;align-items:center;justify-content:center;
      box-shadow:0 4px 14px color-mix(in srgb,var(--ring) 32%,transparent),0 1px 4px rgba(15,23,42,.08);transition:transform .16s ease,box-shadow .16s ease}
    .node:hover .avatar{transform:translateY(-3px) scale(1.13);box-shadow:0 8px 22px color-mix(in srgb,var(--ring) 48%,transparent),0 2px 6px rgba(15,23,42,.1)}
    .avatar .dot{position:absolute;right:-2px;bottom:-2px;width:13px;height:13px;border-radius:50%;border:2.5px solid #f4f7ff;background:#cbd5e1}
    .avatar .dot.on{background:#22c55e;box-shadow:0 0 7px rgba(34,197,94,.75)}
    .label{max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(15,23,42,.78);color:#f1f5ff;font-size:11px;line-height:1;padding:5px 9px;border-radius:999px;display:flex;align-items:center;gap:5px;transition:background .16s ease}
    .label b{background:#1e6fff;color:#fff;font-size:9px;font-weight:700;min-width:14px;height:14px;line-height:14px;border-radius:4.5px;text-align:center;flex:none}
    .node:hover .label{background:color-mix(in srgb,var(--ring) 82%,#000)}
    .dense .avatar{width:44px;height:44px;font-size:15px}
    .dense .label{max-width:92px;font-size:10px;padding:4px 7px}

    .hints{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px 12px 10px;font-size:10.5px;color:#64748b;position:relative;z-index:2}
    .hints i{width:3px;height:3px;border-radius:50%;background:#c3cede}
    kbd{display:inline-block;min-width:15px;padding:1.5px 5px;border-radius:5px;border:1px solid #d4ddf0;border-bottom-width:2px;background:#fff;color:#64748b;font-family:inherit;font-size:9.5px;text-align:center}

    .empty-card{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;border:1px solid #e4eaf6;border-radius:16px;padding:20px 22px;width:240px;text-align:center;box-shadow:0 12px 32px rgba(15,23,42,.1)}
    .empty-ico{font-size:25px;margin-bottom:7px}
    .empty-card h2{margin:0 0 5px;font-size:13px;color:#0f172a}
    .empty-card p{margin:0 0 13px;font-size:11px;line-height:1.7;color:#64748b}
    .empty-card button{border:none;border-radius:9px;background:linear-gradient(135deg,#1e6fff,#4f86ff);color:#fff;font-size:12px;font-weight:600;padding:8px 18px;cursor:pointer;box-shadow:0 6px 16px rgba(30,111,255,.35);transition:transform .15s,box-shadow .15s}
    .empty-card button:hover{transform:translateY(-1px);box-shadow:0 9px 20px rgba(30,111,255,.45)}
  `;
  shadow.append(style);

  const panel = document.createElement('div');
  panel.className = 'panel';
  const head = document.createElement('div');
  head.className = 'head';
  const h1 = document.createElement('h1');
  h1.textContent = '选择账号';
  const sub = document.createElement('p');
  sub.className = 'sub';
  head.append(h1, sub);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'close-btn';
  closeBtn.title = '关闭（Esc）';
  const x = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  x.setAttribute('viewBox', '0 0 12 12');
  x.setAttribute('width', '10');
  x.setAttribute('height', '10');
  const xp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  xp.setAttribute('d', 'M1 1l10 10M11 1L1 11');
  xp.setAttribute('stroke', 'currentColor');
  xp.setAttribute('stroke-width', '1.8');
  xp.setAttribute('stroke-linecap', 'round');
  x.append(xp);
  closeBtn.append(x);

  const stage = document.createElement('div');
  stage.className = 'stage';
  const wheelEl = document.createElement('div');
  wheelEl.className = 'wheel';
  stage.append(wheelEl);

  const hints = document.createElement('div');
  hints.className = 'hints';
  hints.innerHTML =
    '<span><kbd>1-9</kbd> 快速选择</span><i></i><span>点击头像打开标签页</span><i></i><span><kbd>Esc</kbd> 关闭</span>';

  panel.append(head, closeBtn, stage, hints);
  shadow.append(panel);

  let closed = false;
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.removeProperty('overflow');
    host.classList.remove('show');
    WIN.__QL_WHEEL_ACTIVE__ = false;
    window.setTimeout(() => host.remove(), 220);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // 遮罩期间输入框仍可能持有焦点：不劫持编辑键
    const t = e.target as HTMLElement | null;
    if (
      t &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    ) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }
    const idx = Number(e.key) - 1;
    if (!Number.isNaN(idx) && idx >= 0 && idx < 9 && idx < accounts.length) {
      void pick(accounts[idx].id);
    }
  }

  async function pick(accountId: string): Promise<void> {
    close();
    try {
      await chrome.runtime.sendMessage({ kind: 'par.open', id: accountId });
    } catch {
      // 忽略
    }
  }

  closeBtn.addEventListener('click', close);
  shadow.addEventListener('click', (e) => {
    if (e.target === panel || e.target === head || e.target === stage) {
      // 点击面板空白处不关闭；仅点击最外层遮罩才关
    }
  });
  host.addEventListener('click', (e) => {
    if (e.target === host) {
      close();
    }
  });
  host.addEventListener('ql-wheel-close', close);

  /* ---------- 渲染轮盘主体 ---------- */
  const n = accounts.length;
  if (!n) {
    sub.textContent = '还没有任何并行账号';
    const card = document.createElement('div');
    card.className = 'empty-card';
    const ico = document.createElement('div');
    ico.className = 'empty-ico';
    ico.textContent = '🗂️';
    const h2 = document.createElement('h2');
    h2.textContent = '暂无并行账号';
    const p = document.createElement('p');
    p.textContent = '添加账号并授权站点后，这里就会显示可切换的身份。';
    const go = document.createElement('button');
    go.textContent = '去并行管理页添加';
    go.addEventListener('click', async () => {
      close();
      await chrome.tabs.create({ url: PARALLEL_PAGE });
    });
    card.append(ico, h2, p, go);
    wheelEl.append(card);
  } else {
    const onlineCount = accounts.filter((a) => (a.tabIds?.length ?? 0) > 0).length;
    sub.innerHTML = '';
    const cnt = document.createElement('span');
    cnt.textContent = `${n} 个账号`;
    sub.append(cnt);
    if (onlineCount > 0) {
      sub.append(` · ${onlineCount} 个在线`);
      const d = document.createElement('i');
      d.className = 'on-dot';
      sub.prepend(d);
      wheelEl.classList.add('has-online');
    }

    const dense = n >= 9;
    if (dense) {
      wheelEl.classList.add('dense');
    }
    const rx = n <= 6 ? 132 : n <= 8 ? 136 : 142;
    const ry = n <= 6 ? 96 : n <= 8 ? 102 : 108;
    const cx = WHEEL_W / 2;
    const cy = WHEEL_H / 2;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'links');
    svg.setAttribute('viewBox', `0 0 ${WHEEL_W} ${WHEEL_H}`);

    for (let i = 0; i < n; i++) {
      const rad = ((-90 + (360 * i) / n) * Math.PI) / 180;
      const px = Math.cos(rad) * rx;
      const py = Math.sin(rad) * ry;

      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', String(cx));
      line.setAttribute('y1', String(cy));
      line.setAttribute('x2', String(cx + px));
      line.setAttribute('y2', String(cy + py));
      line.style.setProperty('--d', `${0.08 + i * 0.04}s`);
      svg.append(line);

      const a = accounts[i];
      const online = (a.tabIds?.length ?? 0) > 0;
      const node = document.createElement('button');
      node.type = 'button';
      node.style.setProperty('--x', `${px}px`);
      node.style.setProperty('--y', `${py}px`);
      node.style.setProperty('--d', `${0.08 + i * 0.04}s`);

      const avatar = document.createElement('div');
      avatar.style.setProperty('--ring', online ? '#22C55E' : a.color || '#1E6FFF');
      avatar.className = 'avatar';
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

      node.title =
        !a.username || a.username === a.tabName ? a.tabName || a.username : `${a.tabName || a.username}（${a.username}）`;
      node.addEventListener('click', () => void pick(a.id));
      node.append(avatar, label);
      wheelEl.append(node);
    }
    wheelEl.append(svg);

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
  }

  /* ---------- 挂载 & 入场 ---------- */
  document.addEventListener('keydown', onKeyDown, true);
  document.documentElement.style.setProperty('overflow', 'hidden');
  document.documentElement.append(host);
  WIN.__QL_WHEEL_ACTIVE__ = true;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      host.classList.add('show');
      wheelEl.classList.add('in');
    }),
  );
}
