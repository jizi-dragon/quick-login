/**
 * e2e-events.jsonl 离线分析器 —— 从事件流直接产出跨标签证据判定（台架崩溃也不丢证据）。
 *
 * 用法：node tools/e2e/analyze-events.mjs [tmp/e2e-events.jsonl]
 * 输出：控制台结构化判定 + tmp/e2e-events-analysis.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVENTS = process.argv[2] ?? path.join(ROOT, 'tmp', 'e2e-events.jsonl');
const OUT = path.join(ROOT, 'tmp', 'e2e-events-analysis.md');
const SITE = 'tonbridge-config.aksoegmp.com';
const PERM_HINTS = ['menu', 'perm', 'role', 'user', 'auth', 'config', 'module', 'func'];

if (!fs.existsSync(EVENTS)) {
  console.error('事件文件不存在：' + EVENTS);
  process.exit(1);
}

const events = fs
  .readFileSync(EVENTS, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter(Boolean);

const L = [];
const out = (...a) => {
  console.log(...a);
  L.push(a.join(' '));
};

/* ---- 按 URL 聚合 ---- */
const byUrl = new Map();
const touch = (url) => {
  const u = url.split('#')[0];
  if (!byUrl.has(u)) {
    byUrl.set(u, {
      n: 0,
      tabs: new Set(),
      fromCache: 0,
      fromSw: 0,
      qlck: 0,
      authSubs: new Map(), // sub -> Set(tab)
      hashes: new Map(), // md5 -> Set(tab)
      bodyHits: [],
    });
  }
  return byUrl.get(u);
};

for (const e of events) {
  if (e.type === 'req') {
    const st = touch(e.url);
    st.n += 1;
    st.tabs.add(e.tab);
    if (e.qlck) st.qlck += 1;
  } else if (e.type === 'wire-auth') {
    const st = touch(e.url);
    if (!st.authSubs.has(e.authSubject)) st.authSubs.set(e.authSubject, new Set());
    st.authSubs.get(e.authSubject).add(e.tab);
  } else if (e.type === 'from-cache') {
    touch(e.url).fromCache += 1;
  } else if (e.type === 'sw-served') {
    touch(e.url).fromSw += 1;
  } else if (e.type === 'resp-hash') {
    const st = touch(e.url);
    if (!st.hashes.has(e.md5)) st.hashes.set(e.md5, new Set());
    st.hashes.get(e.md5).add(e.tab);
  } else if (e.type === 'body-identity-hit') {
    touch(e.url).bodyHits.push({ tab: e.tab, name: e.matchedAccount });
  }
}

const siteUrls = [...byUrl.entries()].filter(([u]) => u.includes(SITE));

out('══════ 事件流离线分析 ══════');
out(`总事件 ${events.length} · 站点 URL ${siteUrls.length}`);
out('');

/* ---- 0. 各标签线上身份与时间线 ---- */
out('── 零、各标签线上身份（wire-auth 解码）──');
const tabIdent = new Map();
for (const e of events) {
  if (e.type !== 'wire-auth') {
    continue;
  }
  const m = /nameidentifier":"([^"]+)/.exec(e.authSubject ?? '');
  const nid = m ? m[1] : '(非JWT/无nameidentifier)';
  if (!tabIdent.has(e.tab)) {
    tabIdent.set(e.tab, { nids: new Set(), first: e.t, last: e.t, reqs: 0 });
  }
  const info = tabIdent.get(e.tab);
  info.nids.add(nid);
  info.last = Math.max(info.last, e.t);
  info.first = Math.min(info.first, e.t);
}
for (const e of events) {
  if (e.type === 'req' && e.url.includes(SITE)) {
    if (!tabIdent.has(e.tab)) {
      tabIdent.set(e.tab, { nids: new Set(['(未见Authorization)']), first: e.t, last: e.t, reqs: 0 });
    }
    const info = tabIdent.get(e.tab);
    info.reqs += 1;
    info.first = Math.min(info.first, e.t);
    info.last = Math.max(info.last, e.t);
  }
}
for (const [tab, info] of [...tabIdent.entries()].sort((a, b) => a[0] - b[0])) {
  out(
    `- T${tab}: 身份=${[...info.nids].join(' / ')} · 请求数=${info.reqs} · ${new Date(info.first).toLocaleTimeString()} → ${new Date(info.last).toLocaleTimeString()}`,
  );
  if (info.nids.size > 1 && info.nids.has('(非JWT/无nameidentifier)') && info.nids.size <= 2) {
    // 少量非 JWT 请求（登录前）属正常
  } else if (info.nids.size > 1) {
    out(`🚨 单标签多身份：T${tab} 出现 ${info.nids.size} 个不同身份 → token 层串号实锤`);
  }
}
const nidGroups = new Map();
for (const [tab, info] of tabIdent) {
  for (const nid of info.nids) {
    if (nid === '(非JWT/无nameidentifier)') {
      continue;
    }
    if (!nidGroups.has(nid)) {
      nidGroups.set(nid, new Set());
    }
    nidGroups.get(nid).add(tab);
  }
}
for (const [nid, tabs] of nidGroups) {
  if (tabs.size > 1) {
    out(`ℹ 身份 ${nid.slice(0, 24)}… 出现在 T${[...tabs].join(',')}（同账号多标签属正常，注意核对页签名）`);
  }
}
out('');

/* ---- 1. 跨标签同体判定 ---- */
out('── 一、同一 URL 跨标签响应体对照（hash→标签）──');
const multiHash = [];
for (const [u, st] of siteUrls) {
  if (st.hashes.size >= 2) multiHash.push([u, st]);
}
if (multiHash.length) {
  for (const [u, st] of multiHash.slice(0, 20)) {
    const h = [...st.hashes.entries()].map(([m, ts]) => `${m}→T${[...ts]}`).join(' / ');
    out(`⚠ 同 URL 多响应体: ${u.slice(0, 120)} | ${h}`);
  }
} else {
  out('（无）');
}
out('');

/* ---- 2. 同一响应体出现在不同标签（串号核心判据）---- */
out('── 二、同一 API 响应体被不同标签共享（串号判据，已排除静态资源）──');
const isAsset = (u) => /\/assets\//.test(u) || /\.(js|css|png|jpg|svg|woff2?)(\?|$)/i.test(u);
const sharedBody = [];
for (const [u, st] of siteUrls) {
  if (isAsset(u)) {
    continue;
  }
  for (const [m, ts] of st.hashes) {
    if (ts.size >= 2) sharedBody.push({ u, m, tabs: [...ts] });
  }
}
if (sharedBody.length) {
  for (const s of sharedBody.slice(0, 20)) {
    out(`🚨 同体共享: ${s.u.slice(0, 120)} | ${s.m} | T${s.tabs.join(',')}`);
  }
} else {
  out('（无——各标签拿到各自响应体）');
}
out('');

/* ---- 3. SW 命中 ---- */
out('── 三、Service Worker 直接提供的响应 ──');
const swServed = events.filter((e) => e.type === 'sw-served' && e.url.includes(SITE));
if (swServed.length) {
  const agg = new Map();
  for (const e of swServed) {
    const k = e.url.split('?')[0].slice(0, 100);
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }
  for (const [u, n] of [...agg.entries()].slice(0, 25)) out(`- ${n}× ${u}`);
} else {
  out('（无）');
}
out('');

/* ---- 4. _qlck 缺失 ---- */
out('── 四、权限类 GET 未带 _qlck（缓存分区盲区，排除静态资源）──');
const qlckAbs = events.filter((e) => e.type === 'qlck-absent' && !isAsset(e.url));
const qlckTotal = events.filter((e) => e.type === 'req' && e.qlck).length;
out(`（全事件流中带 _qlck 的请求共 ${qlckTotal} 条 ${qlckTotal === 0 ? '—— CACHE 平面疑似未生效！' : ''}）`);
if (qlckAbs.length) {
  const agg = new Map();
  for (const e of qlckAbs) {
    const k = `${e.method} ${e.url.split('?')[0].slice(0, 110)}`;
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }
  for (const [u, n] of [...agg.entries()].slice(0, 25)) out(`- ${n}× ${u}`);
} else {
  out('（无）');
}
out('');

/* ---- 5. 线上身份与缓存命中交叉 ---- */
out('── 五、权限类 URL 的线上身份 / 缓存 / SW 交叉表 ──');
out('| URL | 标签 | n | HTTP缓存 | SW | _qlck | 线上身份 |');
out('|---|---|---|---|---|---|---|');
for (const [u, st] of siteUrls
  .filter(([u2, st2]) => st2.n >= 2 && !isAsset(u2) && PERM_HINTS.some((k) => u2.toLowerCase().includes(k)))
  .sort((a, b) => b[1].n - a[1].n)
  .slice(0, 30)) {
  const subs = [...st.authSubs.entries()]
    .map(([s, ts]) => `T${[...ts]}=${String(s).slice(0, 36)}`)
    .join(' | ');
  out(`| ${u.slice(0, 80)} | T${[...st.tabs]} | ${st.n} | ${st.fromCache} | ${st.fromSw} | ${st.qlck} | ${subs || '-'} |`);
}
out('');

/* ---- 6. 站点环境 ---- */
out('── 六、站点环境探针（SW受控/注册/CacheStorage/IDB）──');
const envs = events.filter((e) => e.type === 'site-env');
if (envs.length) {
  for (const e of envs.slice(-12)) {
    out(
      `- T${e.tab}: 受控=${e.controlled ? '是' : '否'} 注册=${(e.registrations ?? []).map((r) => r.scope).join(',') || '-'} Cache=${(e.caches ?? []).map((c) => `${c.name}×${c.entries}`).join(',') || '-'} IDB=${(e.idb ?? []).join(',') || '-'}`,
    );
  }
} else {
  out('（无——检查点尚未执行）');
}
out('');

/* ---- 7. 页内 cache 调用 ---- */
out('── 七、页内 caches / sw.register 调用日志 ──');
const pc = events.filter((e) => e.type === 'page-console');
if (pc.length) {
  for (const e of pc.slice(-30)) out(`- T${e.tab}: ${e.text.slice(0, 240)}`);
} else {
  out('（无）');
}
out('');

/* ---- 8. 正文身份命中 ---- */
out('── 八、响应正文中的账号名命中 ──');
const bodyHits = events.filter((e) => e.type === 'body-identity-hit');
if (bodyHits.length) {
  for (const e of bodyHits.slice(-15)) out(`- T${e.tab} ${e.url.slice(0, 90)} → 「${e.matchedAccount}」`);
} else {
  out('（无）');
}

/* ---- 综合判定 ---- */
out('', '── 综合判定 ──');
const verdicts = [];
if (qlckTotal === 0 && siteUrls.length > 0) {
  verdicts.push('🚨 全事件流无任何 _qlck 请求 → CACHE 分区 DNR 规则未生效（查绑定表/授权健康/规则安装）');
}
if (sharedBody.length && swServed.length === 0) {
  verdicts.push('同体共享但无 SW 命中 → 指向 HTTP 缓存或服务端合并（看 _qlck 与指纹）');
}
if (sharedBody.some((s) => siteUrls.some(([u, st]) => u.startsWith(s.u.split('?')[0]) && st.fromSw > 0))) {
  verdicts.push('🚨 同体共享 + 该 URL 存在 SW 命中 → 站点 Service Worker 自建缓存层泄漏（第五平面补丁生效点）');
}
if (sharedBody.length && qlckAbs.length) {
  verdicts.push('同体共享 + 权限 URL 缺 _qlck → 缓存分区盲区需扩展覆盖');
}
if (!sharedBody.length && !multiHash.length) {
  verdicts.push('未观察到跨标签响应体串号（本轮操作未复现或泄漏不发生在网络层）');
}
if (!verdicts.length) {
  verdicts.push('证据不足以下结论，需结合运行期报告与指纹对照。');
}
for (const v of verdicts) out('· ' + v);

fs.writeFileSync(OUT, L.join('\n'), 'utf8');
console.log('\n📄 分析已写入 ' + OUT);
