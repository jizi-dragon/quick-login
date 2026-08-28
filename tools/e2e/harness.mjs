/**
 * QuickLogin E2E 台架 —— 真实 Chrome + dist 扩展 + 隔离临时档案。
 *
 * 自动采集的证据（不依赖肉眼比对权限界面）：
 *   A. 每个站点标签页的本地身份：命名空间 localStorage 中的 __auth_token__ 解码、
 *      __device_fp__、可见 document.cookie；
 *   B. 网络层真相：每条请求的线上 Authorization 终值（含 Bearer 主体解码）、
 *      是否命中缓存/Service Worker（requestServedFromCache）、同 URL 跨标签响应对比
 *      （正文里出现哪个账号名 → 直接判定「某账号拿到了别人的数据」）；
 *   C. 扩展内部状态：manifest 版本、parTabBindings、DNR session 规则清单。
 *
 * 运行：
 *   node tools/e2e/harness.mjs              # 交互模式，按提示回车推进
 *   QL_E2E_SELFTEST=1 node tools/e2e/harness.mjs   # 冒烟自检（自动退出）
 *   QL_E2E_DRIVE=file node tools/e2e/harness.mjs   # 文件驱动模式（无人值守 stdin）：
 *     检查点写 tmp/e2e-instructions.txt + 截图 tmp/e2e-shots/，
 *     轮询 tmp/e2e-go（内容含阶段名或 next）推进；QL_E2E_MAX_WAIT_MS 控制最长等待。
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ---------------- 常量与准备 ---------------- */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', 'e2e-profile');
const LOG_FILE = path.join(ROOT, 'tmp', 'e2e-log.jsonl');
const EVENT_FILE = path.join(ROOT, 'tmp', 'e2e-events.jsonl');
const REPORT_FILE = path.join(ROOT, 'tmp', 'e2e-report.md');
const SITE_HOST_DEFAULT = 'tonbridge-config.aksoegmp.com';
const PERM_URL_HINTS = ['menu', 'perm', 'role', 'user', 'auth', 'config', 'module', 'func'];

/** 品牌版 Chrome 137+ 忽略 --load-extension；必须使用 Playwright 自带 Chromium（CFT 构建） */
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(mp)) {
    return null;
  }
  const dirs = fs
    .readdirSync(mp)
    .filter((d) => /^chromium/i.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) {
        return p;
      }
    }
  }
  return null;
}
const EXECUTABLE = process.env.CHROME_PATH ?? findPwChromium();

/**
 * QL_E2E_DRIVE=file：文件驱动推进模式（无人值守 stdin 时用）。
 * 每个检查点：写指令到 tmp/e2e-instructions.txt + 全页面截图到 tmp/e2e-shots/，
 * 然后轮询 tmp/e2e-go（内容含阶段名或 next）推进，超时自动继续。
 * QL_E2E_MAX_WAIT_MS：单检查点最长等待（默认 25 分钟）。
 */
const DRIVE = process.env.QL_E2E_DRIVE === 'file';
const DRIVE_MAX_WAIT_MS = Number(process.env.QL_E2E_MAX_WAIT_MS ?? 25 * 60 * 1000);
const DRIVE_INSTRUCTIONS = path.join(ROOT, 'tmp', 'e2e-instructions.txt');
const DRIVE_GO = path.join(ROOT, 'tmp', 'e2e-go');
const SHOTS_DIR = path.join(ROOT, 'tmp', 'e2e-shots');

const KEPT_PERMS_UNCHANGED = process.env.QL_E2E_KEEP === '1';
const SELFTEST = process.env.QL_E2E_SELFTEST === '1';

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!KEPT_PERMS_UNCHANGED && fs.existsSync(PROFILE)) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

/* ---------------- 全局状态 ---------------- */

/** @type {{t:number,type:string,[k:string]:any}[]} */
let journalStream;
const journal = new Proxy([], {
  set(target, prop, value) {
    target[prop] = value;
    // 事件流实时落盘：崩溃/中断也不丢证据
    if (typeof prop === 'string' && /^\d+$/.test(prop) && journalStream) {
      try {
        journalStream.write(JSON.stringify(value) + '\n');
      } catch {
        // 落盘失败不影响内存态
      }
    }
    return true;
  },
});
let logStream;
const pageIndexOf = new Map();
let pageIndexSeq = 0;

/** url → 统计 {n,tabs:Set(idx),fromCache,authSubs:Set,bodyHashes:Map(hash->{count,tabs:Set,idxSample}),bodies:[{idx,head}]} */
const urlStats = new Map();
/** 已知账号名（交互阶段录入），用于响应正文身份嗅探 */
const knownNames = [];
/** accountId → deviceFp 值登记（跨账号指纹相同性判定用） */
const fpRegistry = new Map();
/** 当前 DNR session 规则快照（refreshAndCheck / writeAnalysis 共用） */
let rules = [];

/* ---------------- 工具函数 ---------------- */

function b64urlDecode(seg) {
  try {
    const pad = seg.length % 4 ? '='.repeat(4 - (seg.length % 4)) : '';
    return Buffer.from(seg.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function decodeToken(token) {
  const parts = String(token).split('.');
  if (parts.length < 2) {
    return null;
  }
  const raw = b64urlDecode(parts[1]);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw.slice(0, 80) };
  }
}

function short(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s && s.length > 160 ? s.slice(0, 157) + '…' : s;
}

function emit(line) {
  console.log(line);
  logStream?.write(line.replace(/\x1b\[[0-9;]*m/g, '') + '\n');
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const enter = () =>
  new Promise((res) => {
    rl.question('', res);
  });

async function waitForGo(phase) {
  try {
    if (fs.existsSync(DRIVE_GO)) {
      fs.rmSync(DRIVE_GO);
    }
  } catch {
    // 忽略
  }
  const t0 = Date.now();
  while (Date.now() - t0 < DRIVE_MAX_WAIT_MS) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const c = fs.readFileSync(DRIVE_GO, 'utf8').trim().toLowerCase();
      if (c === 'probe') {
        // 现场探针信号：不推进阶段，立即采集一轮检查点数据
        try {
          fs.rmSync(DRIVE_GO);
        } catch {
          // 忽略
        }
        emit('🔍 收到现场探针信号，采集一轮…');
        await refreshAndCheck('live');
        continue;
      }
      if (c && (c === 'next' || c === 'go' || c.includes(phase.toLowerCase()))) {
        try {
          fs.rmSync(DRIVE_GO);
        } catch {
          // 忽略
        }
        emit(`✔ 收到推进信号（"${c}"），继续。`);
        return;
      }
    } catch {
      // 信号文件尚未写入
    }
  }
  emit('⚠ 等待推进信号超时，自动继续（证据按已采集状态分析）。');
}

async function captureShots(phase) {
  try {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
  } catch {
    return;
  }
  for (const [page, idx] of pageIndexOf) {
    if (page.isClosed()) {
      continue;
    }
    try {
      const label = (page.url() || 'page').replace(/[^a-z0-9]+/gi, '_').slice(0, 48);
      await page.screenshot({ path: path.join(SHOTS_DIR, `${phase}-p${idx}-${label}.png`) });
    } catch {
      // 截图失败不阻断流程
    }
  }
}

async function announce(phase, steps) {
  emit('');
  steps.forEach((s, i) => emit(`  ${i + 1}. ${s}`));
  if (!DRIVE) {
    emit('  （完成后回车继续）');
    await enter();
    return;
  }
  fs.writeFileSync(
    DRIVE_INSTRUCTIONS,
    `${phase}\n${new Date().toLocaleString()}\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n操作完成后由主持方写入 tmp/e2e-go（内容含「${phase}」或「next」即可推进）。\n`,
    'utf8',
  );
  await captureShots(phase);
  emit(`📸 截图已存 tmp/e2e-shots/${phase}-*.png；等待推进信号（tmp/e2e-go，最长 ${Math.round(DRIVE_MAX_WAIT_MS / 60000)} 分钟）…`);
  await waitForGo(phase);
}

/* ---------------- 扩展内部通道（并行管理页上下文评估） ---------------- */

let ctx;

/** 由 manifest 的固定 key 推导扩展 ID（SHA256(DER公钥) 前 16 字节 → a-p 字母表） */
function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const EXT_ID = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8')).key);
const EXT_PARALLEL_URL = `chrome-extension://${EXT_ID}/ui/parallel/parallel.html`;

let extPage;

async function ensureExtPage() {
  if (extPage && !extPage.isClosed()) {
    return extPage;
  }
  for (const [page] of pageIndexOf) {
    if (!page.isClosed() && page.url().startsWith('chrome-extension://')) {
      extPage = page;
      return extPage;
    }
  }
  extPage = await ctx.newPage();
  await extPage.goto(EXT_PARALLEL_URL);
  return extPage;
}

/**
 * 在扩展页面上下文执行表达式（Playwright 的 newCDPSession 不支持 Worker，
 * 因此弃用原「SW worker CDP」通道，改走扩展管理页——DNR/storage 等 API 同样可用）。
 */
async function extEval(expression) {
  for (let i = 0; i < 5; i++) {
    try {
      const p = await ensureExtPage();
      const r = await p.evaluate(`(async()=>( ${expression} ))()`);
      return r;
    } catch (e) {
      if (i === 4) {
        throw e;
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function getSessionRules() {
  return extEval('chrome.declarativeNetRequest.getSessionRules()');
}

/* ---------------- 扩展 SW 控制台捕获 + 上下文评估（浏览器级 CDP，尽力而为） ---------------- */

let swEvalCdp = null;

async function attachSwConsoleBestEffort() {
  try {
    const bcdp = await ctx.browser().newBrowserCDPSession();
    const swSessions = new Set();
    let extSwSessionId = null;
    let msgId = 0;
    await bcdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

    const attachOne = async (targetInfo, sessionId) => {
      if (targetInfo.type === 'service_worker') {
        swSessions.add(sessionId);
        if (targetInfo.url.endsWith('/background.js')) {
          extSwSessionId = sessionId;
        }
      }
      const mid = ++msgId;
      void bcdp
        .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: mid, method: 'Runtime.enable' }) })
        .catch(() => {});
    };

    // 附着此后新建的目标
    bcdp.on('Target.attachedToTarget', (p) => {
      void attachOne(p.targetInfo, p.sessionId);
    });
    bcdp.on('Target.detachedFromTarget', (p) => {
      swSessions.delete(p.sessionId);
      if (extSwSessionId === p.sessionId) {
        extSwSessionId = null;
      }
    });

    // 附着既存目标（扩展 SW 通常在浏览器启动时就已运行，autoAttach 覆盖不到）
    try {
      const targets = await bcdp.send('Target.getTargets');
      for (const t of targets.targetInfos ?? []) {
        if (t.type !== 'service_worker') {
          continue;
        }
        try {
          const r = await bcdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
          await attachOne(t, r.sessionId);
        } catch {
          // 单个附着失败忽略
        }
      }
    } catch {
      // getTargets 不可用：仅失去既有 SW 附着
    }
    bcdp.on('Runtime.consoleAPICalled', (e) => {
      if (!e.sessionId || !swSessions.has(e.sessionId)) {
        return;
      }
      const text = (e.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
        .trim();
      if (text) {
        journal.push({ t: Date.now(), type: 'sw-console', text: text.slice(0, 300) });
      }
    });
    /** 在扩展 Service Worker 上下文里评估表达式（返回其解析值） */
    swEvalCdp = async (expression, attempts = 8) => {
      for (let i = 0; i < attempts; i++) {
        if (!extSwSessionId) {
          // SW 可能尚未启动：触碰扩展页触发之
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        try {
          const mid = ++msgId;
          const resp = await bcdp.send('Target.sendMessageToTarget', {
            sessionId: extSwSessionId,
            message: JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
          });
          const parsed = JSON.parse(resp.message ?? '{}');
          if (parsed.result?.exceptionDetails) {
            return { err: parsed.result.exceptionDetails.exception?.description ?? 'SW 评估异常' };
          }
          return parsed.result?.result?.value;
        } catch (e) {
          extSwSessionId = null; // 会话失效：等待重新 attach
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      // 失败兜底：列出当前全部目标供诊断
      try {
        const targets = await bcdp.send('Target.getTargets');
        return {
          err: 'SW 会话不可用',
          targets: (targets.targetInfos ?? []).map((t) => `${t.type}:${String(t.url).slice(0, 90)}`),
        };
      } catch (e) {
        return { err: 'SW 会话不可用', targets: 'getTargets 失败: ' + String(e?.message ?? e) };
      }
    };
  } catch (e) {
    emit(`⚠ 浏览器级 CDP 不可用：${e?.message ?? e}`);
  }
}

/* ---------------- 页面挂监 ---------------- */

function indexUrl(url) {
  let st = urlStats.get(url);
  if (!st) {
    st = { n: 0, tabs: new Set(), fromCache: 0, authSubs: new Map(), hashTab: new Map(), hits: [] };
    urlStats.set(url, st);
  }
  return st;
}

function noteBody(url, idx, body) {
  const st = indexUrl(url);
  const hitName = knownNames.find((nm) => nm && body.includes(nm));
  if (hitName && st.hits.length < 24) {
    st.hits.push({ idx, name: hitName });
    journal.push({ t: Date.now(), type: 'body-identity-hit', url, tab: idx, matchedAccount: hitName });
  }
}

async function watchPage(page) {
  if (pageIndexOf.has(page)) {
    return;
  }
  const idx = ++pageIndexSeq;
  pageIndexOf.set(page, idx);

  const onUrlChange = () => journal.push({ t: Date.now(), type: 'nav', tab: idx, url: page.url() });
  onUrlChange();
  page.on('framenavigated', onUrlChange);

  let site = false;
  const updateSite = () => {
    site = /^https?:/i.test(page.url());
  };
  updateSite();

  let cdp;
  try {
    cdp = await ctx.newCDPSession(page);
  } catch {
    return;
  }

  // 页面 realm 早期包装：把站点对 caches / serviceWorker.register / cache.match/put 的
  // 调用经 console 上报（由下方 Runtime.consoleAPICalled 捕获入 journal）——
  // 用于取证「站点 Service Worker / Cache Storage 自建缓存」这一嫌疑层。
  try {
    await page.addInitScript(`(() => {
  if (location.hostname !== ${JSON.stringify(SITE_HOST_DEFAULT)}) { return; }
  const log = (...a) => { try { console.log('[ql-e2e]', ...a); } catch {} };
  try {
    const CP = window.caches && Object.getPrototypeOf(caches);
    if (CP) {
      const oOpen = CP.open, oKeys = CP.keys, oDelete = CP.delete;
      Object.defineProperty(CP, 'open', { configurable: true, value: function (name) { log('caches.open', name); return oOpen.call(this, name); } });
      Object.defineProperty(CP, 'keys', { configurable: true, value: function () { log('caches.keys'); return oKeys.call(this); } });
      Object.defineProperty(CP, 'delete', { configurable: true, value: function (name) { log('caches.delete', name); return oDelete.call(this, name); } });
      const CacheProto = window.Cache && window.Cache.prototype;
      if (CacheProto) {
        const m = CacheProto.match, p = CacheProto.put, am = CacheProto.addAll;
        Object.defineProperty(CacheProto, 'match', { configurable: true, value: function (...a) {
          const k = a[0]; const u = typeof k === 'string' ? k : (k && k.url) || '';
          log('cache.match', u.slice(0, 160)); return m.apply(this, a);
        } });
        Object.defineProperty(CacheProto, 'put', { configurable: true, value: function (...a) {
          const k = a[0]; const u = typeof k === 'string' ? k : (k && k.url) || '';
          log('cache.put', u.slice(0, 160)); return p.apply(this, a);
        } });
        if (am) {
          Object.defineProperty(CacheProto, 'addAll', { configurable: true, value: function (...a) { log('cache.addAll', JSON.stringify(a[0] ?? []).slice(0, 200)); return am.apply(this, a); } });
        }
      }
    }
  } catch (e) { log('wrap-caches-err', String(e)); }
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.register) {
      const orig = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (...a) { log('sw.register', String(a[0] ?? '')); return orig(...a); };
    }
  } catch (e) { log('wrap-sw-err', String(e)); }
})();`);
  } catch {
    // init script 注入失败：仅失去页内 cache 调用日志，不影响其余证据
  }

  await cdp.send('Network.enable');
  try {
    await cdp.send('Runtime.enable');
    cdp.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
        .trim();
      if (text && text.includes('[ql-e2e]')) {
        journal.push({ t: Date.now(), type: 'page-console', tab: idx, text: text.slice(0, 320) });
      }
    });
  } catch {
    // Runtime 域不可用：忽略
  }

  // SW 命中标记（Playwright Response.fromServiceWorker）：响应若由站点 Service Worker
  // 提供，则 DNR 改头/_qlck 缓存分区全程不可见——正是四象限泄漏的头号嫌疑通道。
  page.on('response', (resp) => {
    const url = resp.url();
    if (!url.includes(SITE_HOST_DEFAULT)) {
      return;
    }
    let fromSw = false;
    try {
      fromSw = resp.fromServiceWorker();
    } catch {
      // 旧接口不可用
    }
    const st = indexUrl(url.split('#')[0]);
    if (fromSw) {
      st.fromSw = (st.fromSw ?? 0) + 1;
      journal.push({ t: Date.now(), type: 'sw-served', tab: idx, url: url.slice(0, 300), status: resp.status() });
    }
  });

  const inflight = new Map();
  const cacheSet = new Set();

  cdp.on('Network.requestWillBeSent', (e) => {
    const url = e.request.url;
    if (!url.includes(SITE_HOST_DEFAULT)) {
      return;
    }
    inflight.set(e.requestId, { url });
    const st = indexUrl(url.split('#')[0]);
    st.n += 1;
    st.tabs.add(idx);
    const hasQlck = /[?&]_qlck=/.test(url);
    if (hasQlck) {
      st.qlck = (st.qlck ?? 0) + 1;
    } else if (e.request.method === 'GET' && PERM_URL_HINTS.some((k) => url.toLowerCase().includes(k))) {
      // 权限类 GET 未带 _qlck：缓存分区平面未覆盖该请求（可能是站点自造 URL 或非 XHR 类型）
      journal.push({ t: Date.now(), type: 'qlck-absent', tab: idx, url: url.slice(0, 300), method: e.request.method });
    }
    journal.push({ t: Date.now(), type: 'req', tab: idx, url: url.slice(0, 300), method: e.request.method, qlck: hasQlck });
  });

  // 线上最终请求头（含 DNR 改写后的 Authorization）——存完整解码载荷（不截断，whoOf 判读用）
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const infl = inflight.get(e.requestId);
    const auth = e.headers['Authorization'] ?? e.headers['authorization'];
    if (!infl || typeof auth !== 'string') {
      return;
    }
    const st = indexUrl(infl.url.split('#')[0]);
    const payload = auth.startsWith('Bearer ') ? decodeToken(auth.slice(7)) : null;
    const sub = payload ?? (auth.startsWith('Bearer ') ? auth.slice(7) : '(非Bearer)');
    if (!st.authSubs.has(sub)) {
      st.authSubs.set(sub, new Set());
    }
    st.authSubs.get(sub).add(idx);
    journal.push({
      t: Date.now(),
      type: 'wire-auth',
      tab: idx,
      url: infl.url.slice(0, 300),
      authSubject: sub,
    });
  });

  cdp.on('Network.requestServedFromCache', (e) => {
    cacheSet.add(e.requestId);
  });

  // ---- v3.6 监控补充 1：Set-Cookie 观测（服务端「签发了什么身份材料」给哪个标签页）----
  // responseReceivedExtraInfo.headers['set-cookie'] 含 HttpOnly 全量；requestId→url 由
  // responseReceived 常规事件登记。
  const respUrlById = new Map();
  cdp.on('Network.responseReceived', (e) => {
    if (e.response?.url) {
      respUrlById.set(e.requestId, e.response.url);
    }
  });
  cdp.on('Network.responseReceivedExtraInfo', (e) => {
    const raw = e.headers['set-cookie'] ?? e.headers['Set-Cookie'];
    if (!raw) {
      return;
    }
    const url = respUrlById.get(e.requestId);
    if (!url || !url.includes(SITE_HOST_DEFAULT)) {
      return;
    }
    const lines = Array.isArray(raw) ? raw : String(raw).split('\n');
    const cookies = lines
      .filter(Boolean)
      .map((l) => {
        const nv = l.split(';')[0];
        const eq = nv.indexOf('=');
        return {
          name: eq > 0 ? nv.slice(0, eq).trim() : nv.trim(),
          value: eq > 0 ? nv.slice(eq + 1) : '',
          flags: l
            .split(';')
            .slice(1)
            .map((s) => s.trim().toLowerCase())
            .filter((s) => /^(httponly|secure|samesite|path|domain|expires|max-age)/.test(s)),
        };
      })
      .slice(0, 40);
    journal.push({
      t: Date.now(),
      type: 'set-cookie',
      tab: idx,
      url: url.slice(0, 300),
      status: e.statusCode,
      cookies,
    });
  });

  cdp.on('Network.loadingFinished', async (e) => {
    const infl = inflight.get(e.requestId);
    if (!infl) {
      return;
    }
    const st = indexUrl(infl.url.split('#')[0]);
    if (cacheSet.has(e.requestId)) {
      st.fromCache += 1;
      journal.push({ t: Date.now(), type: 'from-cache', tab: idx, url: infl.url.slice(0, 300) });
    }
    // 身份相关 URL 的响应正文摘要（用于跨账号污染判定）
    if (
      !infl.bodyTried &&
      (PERM_URL_HINTS.some((k) => infl.url.toLowerCase().includes(k)) ||
        /^[^?]*\?(.*&)?_qlck=/.test(infl.url))
    ) {
      infl.bodyTried = true;
      try {
        const r = await cdp.send('Network.getResponseBody', { requestId: e.requestId });
        const body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body;
        if (body && body.length > 40) {
          noteBody(infl.url.split('#')[0], idx, body.slice(0, 20000));
          const st2 = indexUrl(infl.url.split('#')[0]);
          if (st2.hashTab.size < 8) {
            const crypto = await import('node:crypto');
            const h = crypto.createHash('md5').update(body).digest('hex').slice(0, 10);
            if (!st2.hashTab.has(h)) {
              st2.hashTab.set(h, new Set());
            }
            st2.hashTab.get(h).add(idx);
            journal.push({
              t: Date.now(),
              type: 'resp-hash',
              tab: idx,
              url: infl.url.slice(0, 200),
              md5: h,
              size: body.length,
            });
          }
        }
      } catch {
        // 无 body（重定向等）：忽略
      }
    }
    inflight.delete(e.requestId);
  });

  // 本地身份探针缓存（按需刷新）
  page.__qlProbe = async function probeLocalIdentity() {
    updateSite();
    if (!site) {
      return null;
    }
    try {
      return await page.evaluate(async () => {
        const out = {
          namespaces: {},
          cookieView: document.cookie.slice(0, 1600),
          shieldInstalled: typeof (window).__QL_SHIELD_INSTALLED__ === 'boolean',
          patchedView: { length: localStorage.length, keys: [] },
        };
        for (let i = 0; i < Math.min(localStorage.length, 12); i++) {
          const k = localStorage.key(i);
          if (k !== null) {
            out.patchedView.keys.push(k.slice(0, 60));
          }
        }
        let fpSeen = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const m = /^(__ql_ns_[^_]+__(.+))$/.exec(k);
          if (/__device_fp__/.test(k) && !m) {
            fpSeen.push(localStorage.getItem(k));
          }
          if (!m) {
            continue;
          }
          const [, full, rel] = m;
          const acct = full.replace(/^__ql_ns_/, '').replace(/__$/, '');
          if (rel !== '__auth_token__' && rel !== '__device_fp__') {
            continue;
          }
          const v = localStorage.getItem(k);
          if (!out.namespaces[acct]) {
            out.namespaces[acct] = {};
          }
          if (rel === '__auth_token__') {
            const parts = v.split('.');
            try {
              out.namespaces[acct].tokenPayload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
            } catch {
              out.namespaces[acct].tokenPayload = { unparsed: v.slice(0, 40) + '…' };
            }
          } else {
            out.namespaces[acct].deviceFp = v;
          }
        }
        // cookie 中的 token（该平台身份主要载体）→ 页面侧直接解码全量载荷
        const tok = /(?:^|;\s*)__auth_token__=([^;]+)/.exec(document.cookie)?.[1];
        if (tok) {
          try {
            out.cookieTokenPayload = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          } catch {
            out.cookieTokenRaw = tok.slice(0, 80) + '…';
          }
        }
        // IndexedDB 取证：跨标签共享缓存（DBFetch/CacheDb）是缓存分区外的最后嫌疑层
        try {
          if (typeof indexedDB.databases === 'function') {
            const names = (await indexedDB.databases()).map((d) => d.name).filter(Boolean).slice(0, 8);
            const idb = {};
            for (const name of names) {
              try {
                const db = await new Promise((res, rej) => {
                  const r = indexedDB.open(name);
                  r.onsuccess = () => res(r.result);
                  r.onerror = () => rej(r.error);
                });
                const dump = {};
                for (const s of [...db.objectStoreNames].slice(0, 4)) {
                  const tx = db.transaction(s, 'readonly');
                  const st = tx.objectStore(s);
                  const keys = await new Promise((res) => {
                    const q = st.getAllKeys();
                    q.onsuccess = () => res((q.result ?? []).slice(0, 40));
                    q.onerror = () => res([]);
                  });
                  const vals = await new Promise((res) => {
                    const q = st.getAll();
                    q.onsuccess = () => res((q.result ?? []).slice(0, 6));
                    q.onerror = () => res([]);
                  });
                  // DBFetch 判定级摘要（页面侧 WebCrypto）：len+sha1+isAdmin 位+头部
                  const summarize = async (v) => {
                    try {
                      const o = JSON.parse(JSON.stringify(v));
                      const raw = typeof o.values === 'string' ? o.values : JSON.stringify(o.values ?? o);
                      let hash = '';
                      try {
                        const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(raw));
                        hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
                      } catch {
                        hash = 'hash-err';
                      }
                      const admin = /"isAdmin"\s*:\s*true/.test(raw) ? 'ADMIN=TRUE' : /"isAdmin"\s*:\s*false/.test(raw) ? 'admin=false' : '';
                      return {
                        id: String(o.id ?? '').slice(0, 34),
                        len: raw.length,
                        sha1: hash,
                        admin,
                        head: raw.slice(0, 60),
                      };
                    } catch {
                      return { raw: String(v).slice(0, 60) };
                    }
                  };
                  const samples = [];
                  for (const v of vals) {
                    samples.push(await summarize(v));
                  }
                  dump[s] = {
                    count: keys.length,
                    keys: keys.map((k) => String(k).slice(0, 90)),
                    sample: samples,
                  };
                }
                db.close();
                idb[name] = dump;
              } catch (e2) {
                idb[name] = { err: String(e2?.message ?? e2).slice(0, 80) };
              }
            }
            out.idb = idb;
          }
        } catch {
          // IDB 枚举失败不影响其余探针
        }
        // 兼容宽命名空间匹配
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          const mm = /^__ql_ns_(.+?)__(.+)$/.exec(k);
          if (mm && mm[2] === '__device_fp__') {
            fpSeen.push(localStorage.getItem(k));
          }
        }
        out.fpValues = [...new Set(fpSeen)];
        out.plainFp = (() => {
          try {
            return localStorage.getItem('__device_fp__');
          } catch {
            return null;
          }
        })();
        return out;
      });
    } catch {
      return null;
    }
  };

  // 站点环境探针：SW 控制态 / 注册清单 / CacheStorage 内容 / IndexedDB 库名
  page.__qlEnvProbe = async function probeSiteEnv() {
    updateSite();
    if (!site) {
      return null;
    }
    try {
      return await page.evaluate(async () => {
        const out = { controlled: null, registrations: [], caches: [], idb: [] };
        try {
          out.controlled = Boolean(navigator.serviceWorker && navigator.serviceWorker.controller);
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            const regs = await navigator.serviceWorker.getRegistrations();
            out.registrations = regs.map((r) => ({ scope: r.scope, state: r.active ? r.active.state : null }));
          }
        } catch {
          // SW API 不可用
        }
        try {
          if (window.caches && window.caches.keys) {
            const keys = await caches.keys();
            for (const k of keys.slice(0, 30)) {
              try {
                const c = await caches.open(k);
                const reqs = await c.keys();
                out.caches.push({
                  name: k,
                  entries: reqs.length,
                  sample: reqs.slice(0, 3).map((r) => (typeof r === 'string' ? r : r.url).slice(0, 120)),
                });
              } catch {
                out.caches.push({ name: k, entries: -1 });
              }
            }
          }
        } catch {
          // CacheStorage 不可用
        }
        try {
          if (window.indexedDB && window.indexedDB.databases) {
            out.idb = (await indexedDB.databases()).map((d) => d.name);
          }
        } catch {
          // indexedDB.databases 不可用
        }
        return out;
      });
    } catch {
      return null;
    }
  };

  // 原生视图探针：经 CDP 隔离世界读取未打补丁的 localStorage / document.cookie。
  // MAIN 壳只补丁主世界 realm；隔离世界是全新 realm，能穿透补丁看到真实存储与真实 jar。
  page.__qlRawProbe = async function probeRawStorage() {
    updateSite();
    if (!site) {
      return null;
    }
    try {
      const tree = await cdp.send('Page.getFrameTree');
      const mainFrameId = tree.frameTree.frame.id;
      const w = await cdp.send('Page.createIsolatedWorld', {
        frameId: mainFrameId,
        worldName: 'ql-raw-probe',
        grantUniveralAccess: true,
      });
      const r = await cdp.send('Runtime.evaluate', {
        contextId: w.executionContextId,
        returnByValue: true,
        expression: `(() => {
          const out = { length: 0, keys: [], nsKeys: [], cookie: '' };
          try {
            out.length = localStorage.length;
            for (let i = 0; i < Math.min(localStorage.length, 40); i++) {
              const k = localStorage.key(i);
              if (k !== null) {
                out.keys.push(k.slice(0, 70));
                if (k.startsWith('__ql_ns_')) { out.nsKeys.push(k); }
              }
            }
          } catch (e) { out.keysErr = String(e); }
          try { out.cookie = document.cookie.slice(0, 300); } catch (e) { out.cookieErr = String(e); }
          return JSON.stringify(out);
        })()`,
      });
      return JSON.parse(r.result.value ?? '{}');
    } catch (e) {
      return { err: String(e?.message ?? e) };
    }
  };
}

function printProbe(title, probe) {
  if (!probe) {
    emit(`  [${title}] 非 http 页面或探针失败`);
    return;
  }
  const nsKeys = Object.keys(probe.namespaces ?? {});
  if (!nsKeys.length) {
    emit(`  [${title}] 尚无命名空间数据`);
  }
  for (const acct of nsKeys) {
    const info = probe.namespaces[acct];
    const tp = info.tokenPayload;
    const who = tp ? short(tp.name ?? tp.username ?? tp.sub ?? tp.uid ?? tp.preferred_username ?? tp) : '-';
    emit(`  [${title}] 账号 ${acct.slice(0, 8)}… token主体=${who} fp=${(info.deviceFp ?? '').slice(0, 18)}…`);
  }
  if (probe.fpValues?.length > 1) {
    emit(`  [${title}] ⚠ 多个不同设备指纹值并存(${probe.fpValues.length})`);
  }
  emit(`  [${title}] 壳安装=${probe.shieldInstalled === true ? '是' : '否'} · 补丁视图=${probe.patchedView?.length ?? '?'}键[${(probe.patchedView?.keys ?? []).join(', ')}]`);
  emit(`  [${title}] cookie视图=${probe.cookieView ? probe.cookieView.slice(0, 60) + '…' : '(空)'}`);
}

/* ---------------- 报告 ---------------- */

function buildReportHeader(version, rules) {
  const L = [];
  L.push('# QuickLogin E2E 运行报告', '');
  L.push(`- 时间：${new Date().toLocaleString()}`);
  L.push(`- 扩展版本：${version}`);
  L.push(`- DNR 规则数：${rules?.length ?? '?'}`);
  L.push(`- 记录事件：${journal.length}`);
  L.push('');
  return L;
}

/** 线上身份键的可读标签（WIF 声明：nameidentifier 前缀 | name | role） */
function subjLabel(s) {
  if (typeof s !== 'object' || s === null) {
    return short(s).slice(0, 42);
  }
  const keys = Object.keys(s);
  const pick = (suffix) => keys.find((k) => k.endsWith(suffix));
  const guid = s[pick('nameidentifier')];
  const name = s[pick('name')] ?? s.username ?? s.sub ?? s.uid;
  const role = s[pick('role')];
  return `${guid ? String(guid).slice(0, 8) : '?'}|${clipStr(name)}|role=${clipStr(role)}`;
}
function clipStr(v, n = 18) {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function writeAnalysis(lines, version, rules) {
  const L = buildReportHeader(version, rules);

  L.push('## 一、身份相关 URL 跨标签对比', '');
  L.push('| URL | 标签 | 请求数 | HTTP缓存命中 | SW命中 | 不同的线上身份 | 同一URL出现过的唯一响应体(指纹→标签) | 正文命中账号名 |', '|---|---|---|---|---|---|---|---|');
  const rows = [...urlStats.entries()].sort((a, b) => b[1].tabs.size - a[1].tabs.size || b[1].n - a[1].n);
  for (const [url, st] of rows.slice(0, 40)) {
    if (st.n < 2 && st.hits.length === 0) {
      continue;
    }
    const u = url.length > 70 ? url.slice(0, 67) + '…' : url;
    const subs = [...st.authSubs.entries()].map(([s, ts]) => `T${[...ts].join(',')}=${subjLabel(s)}`).join(' | ') || '-';
    const hashes = [...st.hashTab.entries()].map(([h, ts]) => `${h}→T${[...ts]}`).join('/') || '-';
    const hits = st.hits.map((x) => `T${x.idx}:${x.name}`).join(' ') || '';
    L.push(`| ${u} | T${[...st.tabs]} | ${st.n} | ${st.fromCache} | ${st.fromSw ?? 0} | ${subs} | ${hashes} | ${hits} |`);
  }

  L.push('', '## 二、判定线索', '');
  const anyMulti = rows.find(([u, st]) => st.hashTab.size >= 2 && PERM_URL_HINTS.some((k) => u.toLowerCase().includes(k)));
  if (anyMulti) {
    L.push(`- ⚠ 同一权限类 URL 出现多种响应体：${anyMulti[0].slice(0, 100)} —— 若伴随 (disk cache)/(ServiceWorker) 命中即为缓存层泄漏实证。`);
  } else {
    L.push('- 未见同一权限 URL 的多版本响应体。');
  }
  const cacheHeavy = [...urlStats.entries()].filter(([u, st]) => st.fromCache > 0 && PERM_URL_HINTS.some((k) => u.toLowerCase().includes(k)));
  if (cacheHeavy.length) {
    L.push(`- ⚠ 有 ${cacheHeavy.length} 个权限类 URL 存在 HTTP 缓存命中记录（明细见上表）。`);
  } else {
    L.push('- 权限类 URL 无 HTTP 缓存命中记录。');
  }
  // 关键新判定：同一 URL 跨标签响应体一致、但既无 HTTP 缓存命中又有 SW 命中
  // → 站点 Service Worker 自建缓存层直接命中，DNR/_qlck 全程不可见。
  const swSusp = rows.filter(([u, st]) => st.hashTab.size >= 2 && (st.fromCache ?? 0) === 0 && (st.fromSw ?? 0) > 0);
  if (swSusp.length) {
    L.push(`- 🚨 强指向「站点 Service Worker 自建缓存」泄漏：${swSusp.length} 个 URL 跨标签响应体一致、零 HTTP 缓存命中、但有 ${swSusp[0][1].fromSw} 次 SW 命中，样例：${swSusp[0][0].slice(0, 100)}`);
  } else {
    const swHitAny = rows.find(([u, st]) => (st.fromSw ?? 0) > 0);
    if (swHitAny) {
      L.push(`- ℹ 存在 SW 命中但未形成跨标签同体模式（${swHitAny[1].fromSw} 次，${swHitAny[0].slice(0, 80)}）。`);
    } else {
      L.push('- 未观察到任何 SW 命中（站点 Service Worker 未参与本次请求服务）。');
    }
  }
  const qlckAbs = journal.filter((e) => e.type === 'qlck-absent');
  if (qlckAbs.length) {
    L.push(`- ⚠ 有 ${qlckAbs.length} 条权限类 GET 请求未带 _qlck（缓存分区平面未覆盖，样例：${qlckAbs[0].url.slice(0, 100)}）。`);
  } else {
    L.push('- 权限类 GET 请求均携带 _qlck（缓存分区平面覆盖正常）。');
  }
  const jsonlSusp = journal.filter((e) => e.type === 'body-identity-hit');
  if (jsonlSusp.length) {
    L.push('- ⚠ 响应正文中出现账号名（可能跨账号内容错配）：');
    for (const e of jsonlSusp.slice(-12)) {
      L.push(`  - T${e.tab} 请求 ${e.url.slice(0, 90)} → 正文含「${e.matchedAccount}」`);
    }
  } else {
    L.push('- 未在响应正文中检出账号名样例。');
  }

  L.push('', '## 三、站点 Service Worker / Cache Storage 观察', '');
  const swRegs = journal.filter((e) => e.type === 'sw-registered');
  if (swRegs.length) {
    L.push('SW 注册/启动事件：');
    for (const e of swRegs.slice(-10)) {
      L.push(`- ${e.url.slice(0, 160)}`);
    }
  } else {
    L.push('（未观察到 SW 注册/启动事件）');
  }
  L.push('');
  const envs = journal.filter((e) => e.type === 'site-env');
  const lastEnvByTab = new Map();
  for (const e of envs) {
    lastEnvByTab.set(e.tab, e);
  }
  if (lastEnvByTab.size) {
    L.push('各标签最新站点环境：');
    for (const [tab, e] of lastEnvByTab) {
      L.push(
        `- T${tab}: SW受控=${e.controlled ? '是' : '否'} · 注册=${e.registrations.map((r) => `${r.scope}(${r.state})`).join(', ') || '-'} · CacheStorage=${e.caches.map((c) => `${c.name}×${c.entries}`).join(', ') || '-'} · IDB=${e.idb.join(', ') || '-'}`,
      );
    }
  } else {
    L.push('（无站点环境探针数据）');
  }
  const pcLogs = journal.filter((e) => e.type === 'page-console');
  if (pcLogs.length) {
    L.push('', '页内 caches / sw.register 调用日志（[ql-e2e] 包装）：');
    for (const e of pcLogs.slice(-25)) {
      L.push(`- T${e.tab}: ${e.text.slice(0, 260)}`);
    }
  }
  const swServed = journal.filter((e) => e.type === 'sw-served');
  if (swServed.length) {
    L.push('', `SW 直接提供的响应共 ${swServed.length} 次，样例：`);
    for (const e of swServed.slice(-10)) {
      L.push(`- T${e.tab} ${e.status} ${e.url.slice(0, 140)}`);
    }
  }

  L.push('', '## 四、设备指纹对照', '');
  if (fpRegistry.size >= 2) {
    const byVal = new Map();
    for (const [acct, fp] of fpRegistry) {
      const key = fp.slice(0, 24);
      if (!byVal.has(key)) {
        byVal.set(key, []);
      }
      byVal.get(key).push(acct.slice(0, 8));
    }
    let shared = false;
    for (const [fp, accts] of byVal) {
      L.push(`- ${accts.join(', ')} → fp ${fp}…${accts.length > 1 ? '（⚠ 多账号共享同一指纹）' : ''}`);
      if (accts.length > 1) {
        shared = true;
      }
    }
    if (shared) {
      L.push('- 🚨 多个账号共享同一设备指纹：若服务端按设备指纹合并会话/缓存权限，可完整解释四象限泄漏方向性。');
    } else {
      L.push('- 各账号指纹互异，服务端「按指纹合并」假说证据减弱。');
    }
  } else {
    L.push('（登记到的账号指纹不足 2 个，无法对照）');
  }

  L.push('', '## 五、扩展 Service Worker 控制日志摘录', '');
  const conlogs = journal.filter((e) => e.type === 'sw-console');
  for (const e of conlogs.slice(-20)) {
    L.push(`- ${e.text.slice(0, 200)}`);
  }
  if (!conlogs.length) {
    L.push('(空)');
  }

  fs.writeFileSync(REPORT_FILE, L.join('\n'), 'utf8');
  emit(`\n📄 完整报告已写入 ${REPORT_FILE}`);
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (!EXECUTABLE) {
    throw new Error('未找到系统 Chrome，请用环境变量 CHROME_PATH 指定 chrome.exe');
  }
  if (!fs.existsSync(DIST)) {
    throw new Error('dist 不存在，先执行 npm run build');
  }
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'w' });
  journalStream = fs.createWriteStream(EVENT_FILE, { flags: 'w' });

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
      '--disable-features=MediaRouter',
    ],
  });
  console.log('✔ Chrome 已启动（隔离档案：tmp/e2e-profile，不影响你的正式浏览器）');

  for (const p of ctx.pages()) {
    void watchPage(p);
  }
  ctx.on('page', (p) => void watchPage(p));
  ctx.on('serviceworker', (w) => {
    journal.push({ t: Date.now(), type: 'sw-registered', url: w.url() });
    emit(`🔧 站点/扩展 Service Worker 事件: ${w.url()}`);
  });

  // ---- v3.6 监控补充 2：周期身份快照（泄漏的「时间点」与「翻转内容」直接可见）----
  let snapBusy = false;
  async function snapAllIdentities() {
    if (snapBusy) {
      return;
    }
    snapBusy = true;
    try {
      for (const [page] of pageIndexOf) {
        if (page.isClosed() || typeof page.__qlProbe !== 'function') {
          continue;
        }
        if (!/^https?:/.test(page.url())) {
          continue;
        }
        const probe = await page.__qlProbe();
        if (probe) {
          journal.push({
            t: Date.now(),
            type: 'identity-snap',
            tab: pageIndexOf.get(page),
            url: page.url().slice(0, 200),
            probe,
          });
        }
      }
    } catch {
      // 快照失败不影响其余监控
    } finally {
      snapBusy = false;
    }
  }
  setInterval(() => void snapAllIdentities(), 15000);

  /* ---- P0 自检 ---- */
  await attachSwConsoleBestEffort();
  const version = await extEval('chrome.runtime.getManifest().version');
  rules = await getSessionRules();
  emit(`✔ 扩展加载成功 · 版本 ${version} · 初始规则数 ${rules.length}`);
  const bindingsNow = await extEval('(async()=>{const o=(await chrome.storage.session.get("ql:parTabBindings"))["ql:parTabBindings"]||{};return Object.entries(o).map(([tid,b])=>`${tid}->${b.accountId}@${b.host}`)})()');

  if (SELFTEST) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`版本号格式异常：${version}`);
    }
    emit(`✔ SELFTEST 通过（版本 ${version}，SW/DNR 通道可用）`);
    await ctx.close();
    return;
  }

  console.log('\n当前绑定表：' + (bindingsNow?.join(', ') || '(空)'));

  /* ---- P1 ---- */
  await announce('phase1', [
    `并行管理页已自动打开（${EXT_PARALLEL_URL}）：把「站点管理」里的目标站授权好（添加并授权 tonbridge-config.aksoegmp.com）`,
    '新增管理员账号 A 并【添加并打开】，完成登录进入工作台',
    '进入后多点几处权限相关页面/菜单（如「管理端」入口、菜单加载），制造缓存素材',
  ]);
  await refreshAndCheck(1);

  /* ---- P2 ---- */
  await announce('phase2', [
    '继续在同一浏览器新增普通用户 U 并【添加并打开】完成登录',
    '两个页签各自点开一次个人信息页，观察两个页签身份是否各自正确',
  ]);
  await refreshAndCheck(2);

  /* ---- P3：四象限 A 序（关全部 → 开 U → 开 A）---- */
  await announce('phase3', [
    '关闭该站全部页签',
    '先打开普通用户 U（从列表/轮盘打开）并完成登录',
    '再打开管理员 A 并完成登录',
    '对比两个页签的权限（重点：A 的「管理端」类入口是否被剥离；U 是否异常获得管理员权限）',
  ]);
  await refreshAndCheck(3);

  /* ---- P4：四象限 B 序（关全部 → 开 A → 开 U）---- */
  await announce('phase4', [
    '再次关闭该站全部页签',
    '先打开管理员 A 完成登录',
    '再打开普通用户 U 完成登录',
    '对比两个页签的权限（重点：U 是否获得管理员权限）',
  ]);
  await refreshAndCheck(4);

  /* ---- 分析 ---- */
  rules = await getSessionRules();
  writeAnalysis(lines(), version, rules);

  emit('\n浏览器保持打开以便你继续核对；直接关闭 Chrome 窗口即可结束本程序。');
  await new Promise(() => {}); // 保持运行至用户关窗
}

function lines() {
  return []; // 占位：报告由 writeAnalysis 自行汇总 journal
}

/** CDP 全量 IDB dump：真实存储视图（安全原点级），每个库每个仓的条数/键/首行样本 */
async function dumpIdbFull(phase) {
  try {
    for (const [page] of pageIndexOf) {
      if (page.isClosed() || !/^https?:/.test(page.url())) {
        continue;
      }
      const idx = pageIndexOf.get(page);
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('IndexedDB.enable');
        const origin = new URL(page.url()).origin;
        const { databaseNames } = await cdp.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin });
        const dbs = {};
        for (const db of (databaseNames ?? []).slice(0, 12)) {
          try {
            const { entries } = await cdp.send('IndexedDB.requestDatabaseData', {
              securityOrigin: origin,
              databaseName: db,
              pageSize: 200,
            });
            const stores = {};
            for (const entry of entries ?? []) {
              const os = entry.objectStoreContent?.[0];
              stores[entry.objectStore ?? '?'] = {
                count: (entry.objectStoreContent ?? []).length,
                keys: (entry.objectStoreContent ?? []).slice(0, 40).map((r) => JSON.stringify(r.key).slice(0, 70)),
                sample: (entry.objectStoreContent ?? []).slice(0, 2).map((r) => JSON.stringify(r.value).slice(0, 200)),
              };
              void os;
            }
            dbs[db] = stores;
          } catch (e2) {
            dbs[db] = { err: String(e2?.message ?? e2).slice(0, 80) };
          }
        }
        journal.push({ t: Date.now(), type: 'idb-full', phase, tab: idx, origin, dbs });
        emit(`IDB 全量（T${idx}，真实视图）：${Object.keys(dbs).join(', ') || '(空)'}`);
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
  } catch (e) {
    emit(`⚠ IDB 全量取证失败（继续）：${e?.message ?? e}`);
  }
}

async function refreshAndCheck(phase) {
  try {
    await refreshAndCheckInner(phase);
  } catch (e) {
    emit(`⚠ 检查点 ${phase} 采集异常（继续流程）：${e?.message ?? e}`);
  }
}

async function refreshAndCheckInner(phase) {
  rules = await getSessionRules();
  // ---- 回放 Cookie 指纹：每个 Cookie 规则实际回放的是谁家的会话 ----
  try {
    for (const r of rules) {
      const val = r.action?.requestHeaders?.[0]?.value;
      if (r.action.type !== 'modifyHeaders' || typeof val !== 'string') {
        continue;
      }
      const tabMatch = /tab=(\d+)/.exec(JSON.stringify(r.condition ?? {})) ?? [];
      const waf = /HWWAFSESID=(\w{0,12})/.exec(val)?.[1] ?? '(无)';
      journal.push({
        t: Date.now(),
        type: 'replay-cookie',
        phase,
        ruleId: r.id,
        tab: Number(tabMatch[1] ?? 0),
        bytes: val.length,
        waf,
        names: val.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean),
      });
    }
  } catch {
    // 指纹化失败不阻断
  }
  // ---- 真实 jar 直读（CDP Network.getCookies）----
  try {
    for (const [page] of pageIndexOf) {
      if (page.isClosed() || !/^https?:/.test(page.url())) {
        continue;
      }
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('Network.enable');
        const { cookies } = await cdp.send('Network.getCookies', { urls: [new URL(page.url()).origin] });
        journal.push({
          t: Date.now(),
          type: 'jar',
          phase,
          tab: pageIndexOf.get(page),
          cookies: (cookies ?? []).map((c) => ({ name: c.name, head: String(c.value).slice(0, 12) })),
        });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
  } catch {
    // jar 直读失败不阻断
  }
  // ---- 隔离世界原始 LS（绕过页面补丁，读各账号 ns 的 fp/token 原始值）----
  try {
    for (const [page] of pageIndexOf) {
      if (page.isClosed() || !/^https?:/.test(page.url()) || typeof page.__qlProbe !== 'function') {
        continue;
      }
      const cdp = await page.context().newCDPSession(page);
      try {
        const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
          frameId: page.mainFrame()?._id ?? undefined,
          worldName: 'QL_RAW_PROBE',
        });
        const expr = `JSON.stringify(Object.keys(localStorage)
          .filter(k => k.startsWith('__ql_ns_'))
          .map(k => ({ k: k.slice(8, 30), v: String(localStorage.getItem(k)).slice(0, 12) }))
          .concat(Object.keys(localStorage).filter(k => !k.startsWith('__ql_ns_')).slice(0, 10).map(k => ({ k: 'RAW:' + k.slice(0, 22), v: String(localStorage.getItem(k)).slice(0, 12) }))))`;
        const res = await cdp.send('Runtime.evaluate', { expression: expr, contextId: executionContextId, returnByValue: true });
        const rows = JSON.parse(res.result.value ?? '[]');
        const fps = {};
        for (const row of rows) {
          if (row.k.endsWith('__device_fp')) {
            const acct = row.k.split('__')[0];
            fps[acct] = row.v;
          }
        }
        journal.push({ t: Date.now(), type: 'raw-ls', phase, tab: pageIndexOf.get(page), fps, count: rows.length });
      } finally {
        await cdp.detach().catch(() => undefined);
      }
    }
  } catch {
    // 隔离世界取证失败不阻断
  }
  // ---- 全量 IDB 取证（CDP IndexedDB 域 = 浏览器真实存储，绕过页面补丁，可见 Worker 建库）----
  await dumpIdbFull(phase);
  // 扩展 SW 诊断环形缓冲（applyBinding/快照/门控决策）
  try {
    const ring = await extEval('(async()=>{const o=(await chrome.storage.local.get("ql:diag"))["ql:diag"];return (o||[]).slice(-16)})()');
    if (Array.isArray(ring) && ring.length) {
      emit('扩展诊断（ql:diag 最近记录）:');
      for (const d of ring) {
        emit(`  ${d}`);
      }
    }
  } catch {
    // 诊断读取失败不影响主流程
  }
  const extRules = rules.filter((r) => r.id >= 100000);
  emit(`\n───── 检查点 ${phase} ─────`);
  emit(`DNR 会话规则 ${extRules.length} 条:`);
  for (const r of extRules.slice(0, 12)) {
    let desc = r.action.type;
    if (r.action.type === 'modifyHeaders') {
      desc = (r.action.requestHeaders ?? []).map((h) => `${h.header}:${h.operation}`).join(',');
    } else if (r.action.redirect?.urlTransform) {
      desc = 'redirect(urlTransform)';
    }
    emit(`  #${r.id} [${r.condition.resourceTypes.join('/')}] tab=${r.condition.tabIds} domains=${r.condition.requestDomains} ⇒ ${desc}`);
  }
  // v4.1 起缓存分区平面由 MAIN 壳页面层实现（Chrome DNR 无 urlTransform）；
  // 以事件流中带 _qlck 的请求数反映其实际生效情况
  const qlckEvents = journal.filter((e) => e.type === 'req' && e.qlck).length;
  const qlckTabs = new Set(journal.filter((e) => e.type === 'req' && e.qlck).map((e) => e.tab));
  emit(`缓存分区平面（页面壳 _qlck）：带 _qlck 请求 ${qlckEvents} 条 / 覆盖标签 ${[...qlckTabs].map((t) => `T${t}`).join(',') || '-'}`);

  for (const [page] of pageIndexOf) {
    if (page.isClosed()) {
      continue;
    }
    if (typeof page.__qlProbe === 'function' && /^https?:/.test(page.url())) {
      const pidx = pageIndexOf.get(page);
      const probe = await page.__qlProbe();
      printProbe(`页面#${pidx}`, probe);
      // 登记各账号指纹值
      for (const [acct, info] of Object.entries(probe?.namespaces ?? {})) {
        if (typeof info.deviceFp === 'string' && info.deviceFp) {
          fpRegistry.set(acct, info.deviceFp);
        }
      }
      if (typeof page.__qlEnvProbe === 'function') {
        const env = await page.__qlEnvProbe();
        if (env) {
          journal.push({ t: Date.now(), type: 'site-env', tab: pidx, ...env });
          emit(
            `  环境#${pidx}: SW受控=${env.controlled ? '是' : '否'} · 注册=${env.registrations.map((r) => `${r.scope.replace(/^https?:\/\/[^/]+/, '')}(${r.state})`).join(',') || '-'} · CacheStorage=${env.caches.map((c) => `${c.name}×${c.entries}`).join(',') || '-'} · IDB=${env.idb.join(',') || '-'}`,
          );
        }
      }
      if (typeof page.__qlRawProbe === 'function') {
        const raw = await page.__qlRawProbe();
        if (raw) {
          journal.push({ t: Date.now(), type: 'raw-storage', tab: pidx, ...raw });
          emit(
            `  原生#${pidx}: LS键=${raw.length ?? '?'} · 命名空间=${(raw.nsKeys ?? []).map((k) => k.replace(/^__ql_ns_/, '').replace(/__$/, '')).join(',') || '-'} · 原生cookie=${String(raw.cookie ?? '').slice(0, 70) || '(空)'}${raw.err ? ' · ERR ' + raw.err : ''}`,
          );
        }
      }
    }
  }

  const bindList = await extEval(
    '(async()=>{const o=(await chrome.storage.session.get("ql:parTabBindings"))["ql:parTabBindings"]||{};return JSON.stringify(o)})()',
  );
  emit(`绑定表：${bindList}`);

  // 规则安装诊断：权限判定 + 实际试装一条测试 DNR 规则拿真实报错
  const diag = await extEval(`(async()=>{
    const host='${SITE_HOST_DEFAULT}';
    const blocked=(await chrome.storage.local.get('ql:blockedHosts'))['ql:blockedHosts']||[];
    const p1=await chrome.permissions.contains({origins:['*://'+host+'/*']}).catch(e=>'ERR:'+String(e?.message??e));
    const p2=await chrome.permissions.contains({origins:['*://*/*']}).catch(e=>'ERR:'+String(e?.message??e));
    let testErr=null;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({addRules:[{id:999001,priority:1,action:{type:'modifyHeaders',requestHeaders:[{header:'Cookie',operation:'remove'}]},condition:{resourceTypes:['main_frame'],requestDomains:[host],tabIds:[999999]}}]});
      await chrome.declarativeNetRequest.updateSessionRules({removeRuleIds:[999001]});
    } catch(e) { testErr=String(e?.message??e); }
    return JSON.stringify({blocked,p1,p2,testErr});
  })()`);
  emit(`规则安装诊断：${diag}`);

  // SW 上下文诊断：经扩展消息总线在 SW 原地执行（storage.local / DNR / 模块内部状态）
  const swDiag = await extEval(
    '(async()=>{const r=await chrome.runtime.sendMessage({kind:"ql.diag"});return JSON.stringify(r)})()',
  );
  emit(`SW 上下文诊断（ql.diag）：${swDiag}`);

  // 扩展内部诊断埋点（storage.local['ql:diag']）
  const diagLog = await extEval(
    '(async()=>{const d=(await chrome.storage.local.get("ql:diag"))["ql:diag"]||[];return JSON.stringify(d.slice(-30))})()',
  );
  emit(`扩展诊断日志：${diagLog}`);
}

main()
  .then(() => {
    if (SELFTEST) {
      process.exit(0);
    }
  })
  .catch((e) => {
    console.error('\n✖ E2E 失败：', e?.message ?? e);
    console.error('报告如已生成见 tmp/e2e-report.md；事件流见 tmp/e2e-log.jsonl');
    ctx?.close().catch(() => {});
    process.exitCode = 1;
  });
