/**
 * 单环轮盘浮层的共用样式（v3.16）—— 状态轮盘与书签轮盘的浮层 chrome 完全一致，
 * 抽成一处维护（评审里点出的「同一段 CSS 两份维护」问题不再复制）。
 *
 * 依赖 `ring-wheel.ts` 约定的类名族：`.sector*` / `.hub*` / `.hint` / `.toast`。
 */
export const RING_WHEEL_CSS = `
    :host { all: initial; }
    * { margin:0; padding:0; box-sizing:border-box;
        font-family: system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
    :host {
      position:fixed; inset:0; z-index:2147483646;
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px;
      background:rgba(241,245,252,.66);
      backdrop-filter:blur(10px) saturate(1.15);
      opacity:0; transition:opacity .18s ease;
    }
    :host(.show){opacity:1}

    .wheel-root{
      width:min(88vmin,560px);
      transform:scale(.9) translateY(10px);
      transition:transform .28s cubic-bezier(.22,1.3,.36,1), opacity .18s ease;
    }
    :host(.show) .wheel-root{transform:none}
    .wheel-root:not(.in){opacity:.35;transform:scale(.985) rotate(3deg)}

    .sector-wheel svg{
      width:100%; height:auto; display:block;
      filter: drop-shadow(0 26px 60px rgba(23,42,84,.16)) drop-shadow(0 2px 10px rgba(23,42,84,.08));
    }

    .sector{cursor:pointer;transform-box:view-box;transform-origin:50% 50%;
      transform:scale(.96);opacity:0;
      transition:transform .34s cubic-bezier(.22,1.2,.36,1),opacity .3s ease;
      transition-delay:var(--d,0s);}
    .sector-wheel.in .sector{opacity:1;transform:scale(1)}
    .sector:hover{transform:scale(1.016);transition-delay:0s}

    .sector-hit{fill:color-mix(in srgb,var(--acc,#1e6fff) 6%,#ffffff);
      stroke:color-mix(in srgb,var(--acc,#1e6fff) 24%,#e4eaf6);stroke-width:1.6;
      transition:fill .16s ease,stroke .16s ease}
    .sector:hover .sector-hit{
      fill:color-mix(in srgb,var(--acc,#1e6fff) 20%,#ffffff);stroke:var(--acc,#1e6fff)}
    .sector.is-current .sector-hit{
      fill:color-mix(in srgb,var(--acc,#1e6fff) 15%,#ffffff);stroke:var(--acc,#1e6fff);stroke-width:2.2}

    .sector-label{font-size:15px;font-weight:650;fill:#1b2a4a;letter-spacing:.02em;
      pointer-events:none;transition:fill .16s ease}
    .sector.is-current .sector-label{fill:#1e6fff}
    .sector:hover .sector-label{fill:var(--acc,#1e6fff)}

    .sector-num circle{fill:#ffffff;stroke:color-mix(in srgb,var(--acc,#1e6fff) 30%,#e4eaf6);
      stroke-width:1.2;transition:stroke .16s ease,fill .16s ease}
    .sector:hover .sector-num circle{fill:var(--acc,#1e6fff);stroke:var(--acc,#1e6fff)}
    .sector-num text{font-size:11px;font-weight:700;fill:#66759b;
      font-variant-numeric:tabular-nums;pointer-events:none;transition:fill .16s ease}
    .sector:hover .sector-num text{fill:#ffffff}

    .sector-dot{fill:#cbd5e1;pointer-events:none}
    .sector-dot.on{fill:#1e6fff;filter:drop-shadow(0 0 5px rgba(30,111,255,.7))}

    .hub-bg{fill:#ffffff;stroke:#e4eaf6;stroke-width:1.5}
    .hub-box{font-size:15px;font-weight:700;fill:#1b2a4a;letter-spacing:.04em}
    .hub-main{font-size:30px;font-weight:800;fill:#1b2a4a;letter-spacing:.02em}
    .hub-cap{font-size:15px;font-weight:700;fill:#1b2a4a;letter-spacing:.04em}
    .hub-sub{font-size:11px;fill:#66759b;letter-spacing:.05em}

    .hint{
      display:flex; align-items:center; gap:9px;
      font-size:11.5px; color:#5b6b8f; letter-spacing:.05em;
      background:rgba(255,255,255,.82); border:1px solid rgba(228,234,246,.9);
      padding:6px 14px; border-radius:999px;
      box-shadow:0 2px 10px rgba(23,42,84,.06);
      opacity:0; transform:translateY(6px);
      transition:opacity .3s ease .25s, transform .3s ease .25s;
    }
    :host(.show) .hint{opacity:1;transform:none}
    .hint i{width:3px;height:3px;border-radius:50%;background:#c3cede}
    .hint kbd{display:inline-block;min-width:15px;padding:1.5px 6px;border-radius:5px;
      border:1px solid #d4ddf0;border-bottom-width:2px;background:#fff;color:#5b6b8f;
      font-family:inherit;font-size:10px;text-align:center}

    .toast{
      max-width:70vw; padding:9px 18px; border-radius:10px; font-size:13px; font-weight:600;
      box-shadow:0 6px 22px rgba(23,42,84,.12); display:none; text-align:center;
    }
    .toast.show{display:block}
    .toast.info{background:#eff6ff;color:#1e3a8a;border:1px solid #bfdbfe}
    .toast.ok{background:#ecfdf5;color:#14532d;border:1px solid #a7f3d0}
    .toast.err{background:#fef2f2;color:#7f1d1d;border:1px solid #fecaca}
`;
