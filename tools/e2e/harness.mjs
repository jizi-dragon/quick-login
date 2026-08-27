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
 */
import { chromium } from 'playwright-core';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/* ---------------- 常量与准备 ---------------- */

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', 'e2e-profile');
const LOG_FILE = path.join(ROOT, 'tmp', 'e2e-log.jsonl');
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
const SITE_HOST_DEFAULT = 'tonbridge-config.aksoegmp.com';
const PERM_URL_HINTS = ['menu', 'perm', 'role', 'user', 'auth', 'config', 'module', 'func'];

const KEPT_PERMS_UNCHANGED = process.env.QL_E2E_KEEP === '1';
const SELFTEST = process.env.QL_E2E_SELFTEST === '1';

fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
if (!KEPT_PERMS_UNCHANGED && fs.existsSync(PROFILE)) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

/* ---------------- 全局状态 ---------------- */

/** @type {{t:number,type:string,[k:string]:any}[]} */
const journal = [];
let logStream;
const pageIndexOf = new Map();
let pageIndexSeq = 0;

/** url → 统计 {n,tabs:Set(idx),fromCache,authSubs:Set,bodyHashes:Map(hash->{count,tabs:Set,idxSample}),bodies:[{idx,head}]} */
const urlStats = new Map();
/** 已知账号名（交互阶段录入），用于响应正文身份嗅探 */
const knownNames = [];

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

async function announce(steps) {
  console.log('');
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log('  （完成后回车继续）');
  await enter();
}

/* ---------------- Service Worker 通道 ---------------- */

let ctx;
let currentCdp;
let currentSw;

async function ensureSwCdp() {
  // SW 可能被浏览器回收后重启；每次都取最新实例
  let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js'));
  if (!sw || sw !== currentSw || !currentCdp) {
    sw =
      sw ??
      (await Promise.race([
        new Promise((res) => {
          const h = (w) => {
            if (w.url().endsWith('/background.js')) {
              res(w);
            } else {
              ctx.once('serviceworker', h);
            }
          };
          ctx.on('serviceworker', h);
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('等待 Service Worker 超时')), 20000)),
      ]));
    currentSw = sw;
    currentCdp = await ctx.newCDPSession(sw);
    currentCdp.on('Runtime.consoleAPICalled', (e) => {
      const text = (e.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
        .trim();
      if (text) {
        journal.push({ t: Date.now(), type: 'sw-console', text });
      }
    });
    await currentCdp.send('Runtime.enable');
  }
  return currentCdp;
}

async function swEval(expression) {
  for (let i = 0; i < 5; i++) {
    try {
      const cdp = await ensureSwCdp();
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description ?? 'sw eval exception');
      }
      return r.result.value;
    } catch (e) {
      if (i === 4) {
        throw e;
      }
      // SW 重启中：稍候重建
      currentCdp = undefined;
      currentSw = undefined;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
}

async function getSessionRules() {
  return swEval('chrome.declarativeNetRequest.getSessionRules()');
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
  await cdp.send('Network.enable');

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
    journal.push({ t: Date.now(), type: 'req', tab: idx, url: url.slice(0, 300), method: e.request.method });
  });

  // 线上最终请求头（含 DNR 改写后的 Authorization）
  cdp.on('Network.requestWillBeSentExtraInfo', (e) => {
    const infl = inflight.get(e.requestId);
    const auth = e.headers['Authorization'] ?? e.headers['authorization'];
    if (!infl || typeof auth !== 'string') {
      return;
    }
    const st = indexUrl(infl.url.split('#')[0]);
    const sub = auth.startsWith('Bearer ') ? short(decodeToken(auth.slice(7)) ?? auth.slice(7)) : '(非Bearer)';
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
      return await page.evaluate(() => {
        const out = { namespaces: {}, cookieView: document.cookie.slice(0, 400) };
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

function writeAnalysis(lines, version, rules) {
  const L = buildReportHeader(version, rules);

  L.push('## 一、身份相关 URL 跨标签对比', '');
  L.push('| URL | 标签 | 请求数 | 命中缓存次数 | 不同的线上身份 | 同一URL出现过的唯一响应体(指纹→标签) | 正文命中账号名 |', '|---|---|---|---|---|---|---|');
  const rows = [...urlStats.entries()].sort((a, b) => b[1].tabs.size - a[1].tabs.size || b[1].n - a[1].n);
  for (const [url, st] of rows.slice(0, 40)) {
    if (st.n < 2 && st.hits.length === 0) {
      continue;
    }
    const u = url.length > 70 ? url.slice(0, 67) + '…' : url;
    const subs = [...st.authSubs.entries()].map(([s, ts]) => `T${[...ts].join(',')}=${short(s).slice(0, 42)}`).join(' | ') || '-';
    const hashes = [...st.hashTab.entries()].map(([h, ts]) => `${h}→T${[...ts]}`).join('/') || '-';
    const hits = st.hits.map((x) => `T${x.idx}:${x.name}`).join(' ') || '';
    L.push(`| ${u} | T${[...st.tabs]} | ${st.n} | ${st.fromCache} | ${subs} | ${hashes} | ${hits} |`);
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
    L.push(`- ⚠ 有 ${cacheHeavy.length} 个权限类 URL 存在缓存命中记录（明细见上表）。`);
  } else {
    L.push('- 权限类 URL 无缓存命中记录。');
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

  L.push('', '## 三、Service Worker 控制日志摘录', '');
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

  /* ---- P0 自检 ---- */
  const version = await swEval('chrome.runtime.getManifest().version');
  let rules = await getSessionRules();
  emit(`✔ 扩展加载成功 · 版本 ${version} · 初始规则数 ${rules.length}`);
  const bindingsNow = await swEval('(async()=>{const o=(await chrome.storage.session.get("ql:parTabBindings"))["ql:parTabBindings"]||{};return Object.entries(o).map(([tid,b])=>`${tid}->${b.accountId}@${b.host}`)})()');

  if (SELFTEST) {
    if (version !== '3.4.0') {
      throw new Error(`期望版本 3.4.0，实际 ${version}`);
    }
    emit('✔ SELFTEST 通过（版本 3.4.0 与 SW 通道可用）');
    await ctx.close();
    return;
  }

  console.log('\n当前绑定表：' + (bindingsNow?.join(', ') || '(空)'));

  /* ---- P1 ---- */
  await announce(['打开并行管理页（扩展图标），把「站点管理」里的目标站授权好', '新增管理员账号 A 并【添加并打开】，完成登录进入工作台']);
  await refreshAndCheck(1);

  /* ---- P2 ---- */
  await announce(['继续在同一浏览器新增普通用户 U 并【添加并打开】完成登录', '两个页签各自点开一次个人信息页']);
  await refreshAndCheck(2);

  /* ---- P3：自由复现场景 ---- */
  console.log('\n接下来是自由复现窗口：按你此前的四象限顺序操作（关全部→开A→开U 或 关全部→开U→开A）。');
  console.log('期间所有网络证据持续记录中…… 操作完一轮后回车开始分析。\n');
  await enter();
  await refreshAndCheck(3);

  /* ---- 分析 ---- */
  rules = await getSessionRules();
  writeAnalysis(lines(), version, rules);

  emit('\n浏览器保持打开以便你继续核对；直接关闭 Chrome 窗口即可结束本程序。');
  await new Promise(() => {}); // 保持运行至用户关窗
}

function lines() {
  return []; // 占位：报告由 writeAnalysis 自行汇总 journal
}

async function refreshAndCheck(phase) {
  rules = await getSessionRules();
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
  const dupQlck = {};
  for (const r of extRules) {
    const qs = JSON.stringify(r.action.redirect?.urlTransform ?? {});
    if (qs.includes('_qlck')) {
      dupQlck[r.id] = r.condition.tabIds;
    }
  }
  const vals = new Set(Object.values(dupQlck).map(JSON.stringify));
  emit(`缓存分区规则 ${Object.keys(dupQlck).length} 条 / 不同分区键 ${vals.size} 组${Object.keys(dupQlck).length !== vals.size ? '（应为相等数量——每标签一组）' : ''}`);

  for (const [page] of pageIndexOf) {
    if (page.isClosed()) {
      continue;
    }
    if (typeof page.__qlProbe === 'function' && /^https?:/.test(page.url())) {
      printProbe(`页面#${pageIndexOf.get(page)}`, await page.__qlProbe());
    }
  }

  const bindList = await swEval(
    '(async()=>{const o=(await chrome.storage.session.get("ql:parTabBindings"))["ql:parTabBindings"]||{};return JSON.stringify(o)})()',
  );
  emit(`绑定表：${bindList}`);
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
