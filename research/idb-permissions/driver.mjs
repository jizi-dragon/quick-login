/**
 * IDB 专项研究驱动器 —— 文件驱动命令循环。
 * 命令写入 tmp/research-idb/go（每行一条）；结果追加 tmp/research-idb/log.jsonl。
 * 命令集：SNAP / SETADMIN <tab> <true|false> / COPYENTRY <srcTab> <dstTab> <isAdmin|menu> /
 *         RELOAD <tab> / PROBE <tab> / STATUS
 * 说明：页面侧改写经 CDP Runtime.evaluate（绕过 CSP）；indexedDB.open 走页面补丁 →
 *       自动落本账号命名空间库，应用即刻可读。
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DIST = process.env.QL_RESEARCH_DIST ?? path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', 'research-profile');
const DIR = path.join(ROOT, 'tmp', 'research-idb');
const GO = path.join(DIR, 'go');
const LOG = path.join(DIR, 'log.jsonl');
const SITE_HOST = 'tonbridge-config.aksoegmp.com';

fs.mkdirSync(DIR, { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: 'a' });
const emit = (m) => {
  console.log(m);
  logStream.write(JSON.stringify({ t: Date.now(), msg: String(m) }) + '\n');
};
const jlog = (o) => {
  const rec = { t: Date.now(), ...o };
  logStream.write(JSON.stringify(rec) + '\n');
};

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(mp)) return null;
  for (const d of fs.readdirSync(mp).filter((x) => /^chromium/i.test(x)).sort().reverse()) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const EXECUTABLE = process.env.CHROME_PATH ?? findPwChromium();
if (!EXECUTABLE) {
  console.error('未找到 Playwright Chromium，先 npx playwright-core install chromium');
  process.exit(1);
}

let ctx;
const siteTabs = () => [...ctx.pages()].filter((p) => !p.isClosed() && p.url().includes(SITE_HOST));
const tabByNum = (n) => siteTabs()[Number(n) - 1] ?? null;

/** CSP 安全的页面求值通道 */
async function pageEval(page, fnSrc, arg) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const expr = `(${fnSrc})(${JSON.stringify(arg ?? {})})`;
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval error');
    }
    return r.result?.value;
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/* ---------------- SNAP：页面侧全量 IDB（补丁 open → 本账号命名空间库，值内联可解析） ---------------- */
let snapSeq = fs
  .readdirSync(DIR)
  .filter((f) => /^snap-\d+/.test(f))
  .map((f) => Number(f.match(/^snap-(\d+)/)[1]))
  .reduce((a, b) => Math.max(a, b), 0);

const DUMP_FN = `async function() {
  const names = await indexedDB.databases().then((a) => a.map((x) => x.name)).catch(() => []);
  const out = {};
  for (const name of names) {
    out[name] = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const storeNames = Array.from(db.objectStoreNames);
        const result = {};
        let left = storeNames.length;
        if (!left) { db.close(); resolve(result); return; }
        for (const sname of storeNames) {
          const tx = db.transaction(sname, 'readonly');
          const all = tx.objectStore(sname).getAll();
          const cap = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > 100000 ? s.slice(0, 100000) + '…<截断>' : s; };
          all.onsuccess = () => {
            result[sname] = { count: (all.result || []).length, entries: (all.result || []).map((it, i) => ({ key: String(it.id ?? i), value: cap(it) })) };
            if (--left === 0) { db.close(); resolve(result); }
          };
          all.onerror = () => { if (--left === 0) { db.close(); resolve(result); } };
        }
      };
    });
  }
  return out;
}`;

async function cmdSnap() {
  for (const page of siteTabs()) {
    const idx = siteTabs().indexOf(page) + 1;
    try {
      const dbs = await pageEval(page, DUMP_FN, {});
      snapSeq += 1;
      const file = path.join(DIR, `snap-${String(snapSeq).padStart(3, '0')}-T${idx}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ t: Date.now(), tab: idx, url: page.url(), note: '库名为裸名；真实存储按 __ql_ns_<accountId>__ 前缀', dbs }, null, 1),
      );
      jlog({ type: 'snap', tab: idx, file: path.basename(file), dbs: Object.keys(dbs) });
      emit(`SNAP T${idx} → ${path.basename(file)}（${Object.keys(dbs).length} 库：${Object.keys(dbs).join(', ')}）`);
    } catch (e) {
      emit(`SNAP T${idx} 失败：${e?.message ?? e}`);
    }
  }
}

/* ---------------- 页面侧读写（命名空间库内） ---------------- */
const FIND_ENTRY_FN = `async function(arg) {
  const finder = arg.finder;
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('DBFetch');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('DBFetch', 'readonly');
      const all = tx.objectStore('DBFetch').getAll();
      all.onsuccess = () => {
        db.close();
        const items = all.result || [];
        const rawOf = (it) => (typeof it.values === 'string' ? it.values : JSON.stringify(it.values || ''));
        const hit = items.find((it) =>
          finder === 'isAdmin' ? rawOf(it).includes('"isAdmin"')
          : finder === 'menu' ? (rawOf(it).includes('menuId') || rawOf(it).includes('首页'))
          : String(it.id).startsWith(finder));
        resolve(hit ? { id: hit.id, values: rawOf(hit) } : null);
      };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
}`;

const WRITE_ENTRY_FN = `async function(arg) {
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('DBFetch');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('DBFetch', 'readwrite');
      const id = arg.forceId || ('ql-rw-' + Date.now().toString(36));
      tx.objectStore('DBFetch').put({ id: id, values: arg.values });
      tx.oncomplete = () => { db.close(); resolve({ id: id, ok: true }); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  });
}`;

const SETADMIN_FN = `async function(arg) {
  const want = String(arg.want);
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('DBFetch');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('DBFetch', 'readwrite');
      const st = tx.objectStore('DBFetch');
      const changes = [];
      const all = st.getAll();
      all.onsuccess = () => {
        const items = all.result || [];
        if (!items.length) { tx.oncomplete = () => { db.close(); resolve([]); }; return; }
        let left = items.length;
        for (const it of items) {
          const raw = typeof it.values === 'string' ? it.values : JSON.stringify(it.values || '');
          const m = raw.match(/"isAdmin"(\\s*:\\s*)(true|false)/);
          if (m && m[2] !== want) {
            const nv = raw.replace(/("isAdmin")(\\s*:\\s*)(true|false)/, '$1$2' + want);
            st.put(Object.assign({}, it, { values: nv }));
            changes.push({ id: it.id, from: m[2], to: want });
          }
          if (--left === 0) {
            tx.oncomplete = () => { db.close(); resolve(changes); };
            tx.onerror = () => { db.close(); reject(tx.error || new Error('tx failed')); };
          }
        }
      };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
}`;

/* LS：命名空间 localStorage 全量 dump（含 user_center_power 权限矩阵） */
const LS_FN = `async function() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    let v = localStorage.getItem(k) || '';
    if (v.length > 4000) v = v.slice(0, 4000) + '…<截断>';
    out[k] = v;
  }
  return out;
}`;

/* APITEST：以页面自身身份（补丁后的 Bearer/Cookie）重放任意接口 */
const API_FN = `async function(arg) {
  const r = await fetch(arg.path, { method: arg.method || 'GET', headers: { Accept: 'application/json' }, credentials: 'omit' });
  const body = await r.text();
  return { status: r.status, body: body.slice(0, 600) };
}`;

/* EDIT：精细编辑条目 values JSON 的嵌套字段（jsonPath 如 [0].pageList.3.isEnabled，value 为 JSON 字面量） */
const EDIT_FN = `async function(arg) {
  const { idPrefix, jsonPath, literal } = arg;
  const setPath = (obj, path, val) => {
    const segs = path.replace(/^\\[|\\]$/g, '').split(/[.[]/).map((s) => s.replace(/\\]$/, ''));
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = /^\\d+$/.test(segs[i]) ? Number(segs[i]) : segs[i];
      cur = cur[k];
      if (cur === undefined || cur === null) throw new Error('path 断在 ' + segs[i]);
    }
    const last = segs[segs.length - 1];
    cur[/^\\d+$/.test(last) ? Number(last) : last] = val;
  };
  return await new Promise((resolve, reject) => {
    const req = indexedDB.open('DBFetch');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('DBFetch', 'readwrite');
      const st = tx.objectStore('DBFetch');
      const all = st.getAll();
      all.onsuccess = () => {
        const hit = (all.result || []).find((it) => String(it.id).startsWith(idPrefix));
        if (!hit) { db.close(); resolve({ ok: false, err: 'no entry' }); return; }
        const outer = JSON.parse(hit.values);
        const payload = typeof outer.values === 'string' ? JSON.parse(outer.values) : outer.values;
        setPath(payload, jsonPath, JSON.parse(literal));
        const nv = JSON.stringify(Object.assign({}, outer, { values: JSON.stringify(payload) }));
        st.put(Object.assign({}, hit, { values: nv }));
        tx.oncomplete = () => { db.close(); resolve({ ok: true, id: hit.id }); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      all.onerror = () => { db.close(); reject(all.error); };
    };
  });
}`;

/* ---------------- 命令执行 ---------------- */
async function runCommand(line) {
  const parts = line.trim().split(/\s+/);
  const cmd = (parts[0] ?? '').toUpperCase();
  jlog({ type: 'cmd', cmd, raw: line.trim() });
  emit(`▶ ${line.trim()}`);
  try {
    if (cmd === 'SNAP') {
      await cmdSnap();
    } else if (cmd === 'STATUS') {
      const tabs = siteTabs();
      if (!tabs.length) emit('(无站点标签页)');
      tabs.forEach((p, i) => emit(`T${i + 1} ${p.url().slice(0, 90)}`));
    } else if (cmd === 'RELOAD') {
      const p = tabByNum(parts[1]);
      if (p) { await p.reload({ waitUntil: 'domcontentloaded' }); emit(`T${parts[1]} 已刷新`); }
      else emit(`无 T${parts[1]}`);
    } else if (cmd === 'SETADMIN') {
      const p = tabByNum(parts[1]);
      if (!p) return emit(`无 T${parts[1]}`);
      const r = await pageEval(p, SETADMIN_FN, { want: parts[2] === 'true' });
      jlog({ type: 'setadmin', tab: Number(parts[1]), want: parts[2], changes: r });
      emit(`T${parts[1]} isAdmin→${parts[2]}：${JSON.stringify(r)}`);
    } else if (cmd === 'COPYENTRY') {
      const src = tabByNum(parts[1]);
      const dst = tabByNum(parts[2]);
      const finder = parts[3] ?? 'isAdmin';
      if (!src || !dst) return emit('标签页不存在');
      const entry = await pageEval(src, FIND_ENTRY_FN, { finder });
      if (!entry) return emit(`T${parts[1]} 未找到含 ${finder} 的条目`);
      const r = await pageEval(dst, WRITE_ENTRY_FN, { values: entry.values, forceId: entry.id });
      jlog({ type: 'copyentry', src: Number(parts[1]), dst: Number(parts[2]), finder, id: entry.id, len: entry.values.length });
      emit(`T${parts[1]}→T${parts[2]} 复制 ${finder} 条目 id=${entry.id.slice(0, 12)}… len=${entry.values.length} → ${JSON.stringify(r)}`);
    } else if (cmd === 'LS') {
      const p = tabByNum(parts[1]);
      if (!p) return emit(`无 T${parts[1]}`);
      const ls = await pageEval(p, LS_FN, {});
      const keys = Object.keys(ls ?? {});
      jlog({ type: 'ls', tab: Number(parts[1]), keys });
      emit(`T${parts[1]} localStorage 共 ${keys.length} 键：${keys.join(', ').slice(0, 400)}`);
      for (const [k, v] of Object.entries(ls ?? {})) {
        if (/power|perm|menu|auth|config/i.test(k)) {
          emit(`  ★ ${k} = ${String(v).slice(0, 500)}`);
          logStream.write(JSON.stringify({ t: Date.now(), type: 'ls-entry', tab: Number(parts[1]), key: k, value: v }) + '\n');
        }
      }
    } else if (cmd === 'APITEST') {
      const p = tabByNum(parts[1]);
      if (!p) return emit(`无 T${parts[1]}`);
      const path = parts[2];
      const method = (parts[3] ?? 'GET').toUpperCase();
      const r = await pageEval(p, API_FN, { path, method });
      jlog({ type: 'apitest', tab: Number(parts[1]), path, method, status: r?.status, body: r?.body?.slice(0, 300) });
      emit(`T${parts[1]} ${method} ${path} → HTTP ${r?.status}  ${String(r?.body).slice(0, 200)}`);
    } else if (cmd === 'EDIT') {
      const p = tabByNum(parts[1]);
      if (!p) return emit(`无 T${parts[1]}`);
      const r = await pageEval(p, EDIT_FN, { idPrefix: parts[2], jsonPath: parts[3], literal: parts.slice(4).join(' ') });
      jlog({ type: 'edit', tab: Number(parts[1]), idPrefix: parts[2], jsonPath: parts[3], result: r });
      emit(`T${parts[1]} EDIT ${parts[3]} → ${JSON.stringify(r)}`);
    } else if (cmd === 'PROBE') {
      const p = tabByNum(parts[1]);
      if (!p) return emit(`无 T${parts[1]}`);
      const info = await pageEval(p, `async function() {
        const tok = /(?:^|;\\s*)__auth_token__=([^;]+)/.exec(document.cookie) ? document.cookie.match(/__auth_token__=([^;]+)/)[1] : '';
        let sub = '';
        try { sub = atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')).replace(/\\s+/g, ' ').slice(0, 120); } catch (e) {}
        return { url: location.href.slice(0, 90), tokenSub: sub };
      }`, {});
      jlog({ type: 'probe', tab: Number(parts[1]), ...info });
      emit(`T${parts[1]} ${info.url} · token主体=${info.tokenSub}`);
    } else {
      emit(`未知命令：${cmd}`);
    }
  } catch (e) {
    emit(`命令失败：${e?.message ?? e}`);
    jlog({ type: 'cmd-error', cmd, err: String(e?.message ?? e) });
  }
}

/* ---------------- 启动 ---------------- */
ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EXECUTABLE,
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--hide-crash-restore-bubble',
    '--disable-sync',
  ],
});
emit(`研究浏览器已启动（dist ${JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')).version} · 隔离档案）。等待 ${GO} 命令…`);
ctx.on('page', (p) => {
  p.on('load', () => {
    if (!p.isClosed() && p.url().includes(SITE_HOST)) {
      emit(`页面加载: T${siteTabs().indexOf(p) + 1} ${p.url().slice(0, 80)}`);
    }
  });
});

const queue = {
  chain: Promise.resolve(),
  add(fn) {
    this.chain = this.chain.then(fn).catch((e) => emit(`队列错误: ${e?.message ?? e}`));
    return this.chain;
  },
};
setInterval(() => {
  try {
    if (!fs.existsSync(GO)) return;
    const content = fs.readFileSync(GO, 'utf8').trim();
    if (!content) return;
    fs.rmSync(GO);
    for (const line of content.split('\n').filter((l) => l.trim())) {
      void queue.add(() => runCommand(line));
    }
  } catch { /* 轮询容错 */ }
}, 1500);
