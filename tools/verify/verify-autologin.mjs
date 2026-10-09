/** v3.10.5 验证：自动登录自愈式提交（首次点击被吞 → 重试成功；用户接管 → 让位） */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const mfPath = path.join(DIST, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
mf.host_permissions = ['*://example.com/*'];
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`); };

const profile = path.join(ROOT, 'tmp', 'ui-autologin');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
const consoleLogs = [];
const hookLogs = (p) => {
  p.on('console', (m) => { const t = m.text(); if (t.includes('[ql-auto]') || m.type() === 'error') consoleLogs.push(`[${m.type()}] ${t.slice(0, 160)}`); });
  p.on('pageerror', (e) => consoleLogs.push(`[pageerror] ${String(e).slice(0, 200)}`));
};
hookLogs(page);
ctx.on('page', hookLogs);
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

const waitExamplePage = async () => {
  for (let i = 0; i < 30; i++) {
    const p = [...ctx.pages()].filter((x) => x.url().startsWith('https://example.com')).pop();
    if (p) return p;
    await sleep(500);
  }
  throw new Error('example.com 页签未出现');
};

/* 场景 A：首次点击被吞（handler 延迟 1.5s 绑定）→ 自愈重试应成功提交 */
const acc = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'A1', username: 'alice', password: 'pw123', open: false }))).result.data;
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
await sleep(1500);
const tab1 = await waitExamplePage();

await tab1.evaluate(() => {
  document.body.innerHTML = `
    <form onsubmit="return false">
      <input placeholder="请输入用户名" type="text" />
      <iframe srcdoc='<input type="password" placeholder="密码" />'></iframe>
      <input type="checkbox" id="privacyChecked" />
      <button type="button">登 录</button>
    </form>`;
  document.body.dataset.loginClicked = '0';
  document.body.dataset.clickSeen = '0';
  // 捕获层监听：只要 click 事件抵达按钮就计数（与 handler 是否绑定无关）
  document.querySelector('button').addEventListener('click', () => {
    document.body.dataset.clickSeen = String(Number(document.body.dataset.clickSeen) + 1);
  }, { capture: true });
  // 模拟低代码平台：1.5 秒后才绑定提交 handler（首次点击应落在未绑定窗口）
  setTimeout(() => {
    document.querySelector('button').addEventListener('click', () => {
      const u = document.querySelector('input[type=text]').value;
      const p = document.querySelector('iframe').contentDocument.querySelector('input[type=password]').value;
      document.body.dataset.loginClicked = String(Number(document.body.dataset.loginClicked) + 1);
      document.body.dataset.submittedU = u;
      document.body.dataset.submittedP = p;
    });
  }, 1500);
});
const t0 = Date.now();
let clicked = '0';
const series = [];
for (let i = 0; i < 24; i++) {
  clicked = await tab1.evaluate(() => `${document.body.dataset.loginClicked}/${document.body.dataset.clickSeen}`);
  series.push(`t+${Math.round((Date.now() - t0) / 1000)}s:${clicked}`);
  if (Number(clicked.split('/')[0]) > 0) break;
  await sleep(500);
}
console.log(`  点击序列: ${series.join(' ')}`);
const submittedU = await tab1.evaluate(() => document.body.dataset.submittedU ?? '');
const submittedP = await tab1.evaluate(() => document.body.dataset.submittedP ?? '');
const elapsed = Date.now() - t0;
const [handlerHits, clickSeen] = clicked.split('/');
check('A0 点击事件确实派发到按钮', Number(clickSeen) >= 1, `clickSeen=${clickSeen}`);
check('A1 首次点击无反应后自愈重试成功（handler 迟到仍提交）', Number(handlerHits) >= 1, `handler命中=${handlerHits} 耗时=${Math.round(elapsed / 1000)}s`);
check('A2 提交时表单值完整（回填防御重渲染清值）', submittedU === 'alice' && submittedP === 'pw123', `u=${submittedU} p=${submittedP}`);
check('A3 未连点轰炸（重试≤4 次）', Number(clickSeen) <= 4, `点击=${clickSeen}次`);

/* 场景 B：自动流程运行中用户手动键入 → 立即让位，不覆盖用户输入 */
const acc2 = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'B1', username: 'auto-user', password: 'auto-pass', open: false }))).result.data;
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc2.id);
await sleep(2000);
const tab2 = await waitExamplePage();
await tab2.evaluate(() => {
  document.body.innerHTML = `
    <form onsubmit="return false">
      <input placeholder="请输入用户名" type="text" />
      <iframe srcdoc='<input type="password" placeholder="密码" />'></iframe>
      <input type="checkbox" id="privacyChecked" />
      <button type="button">登 录</button>
    </form>`;
});
await sleep(1500); // 自动填表发生
await tab2.focus('input[type=text]');
await tab2.keyboard.type('my-own-name', { delay: 40 }); // trusted 输入 → userTouched
await sleep(2000);
const afterUser = await tab2.evaluate(() => document.querySelector('input[type=text]').value);
check('B1 用户手动键入后自动流程让位（用户输入保留，不被自动值覆盖）', afterUser.includes('my-own-name'), `值=${afterUser}`);

await ctx.close();
console.log(`页面错误/警告: ${consoleLogs.length ? JSON.stringify(consoleLogs.slice(0, 60), null, 1) : '无'}`);
console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
