/** 亲子继承（opener 继承）功能验证（v3.9.6） */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
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
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const profile = path.join(ROOT, 'tmp', 'ui-adopt-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

const diag = () => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' }));
const bindingsOf = async () => (await diag())?.result?.data?.parallel?.bindings ?? [];

const r = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: '账号A', username: 'ua', password: 'p', open: true }));
if (!r?.result?.ok) { console.log('建号失败:', JSON.stringify(r)); process.exit(1); }
const accountId = r.result.data.id;
await page.waitForTimeout(1500);
const bs0 = await bindingsOf();
const tabA = bs0.find((b) => b.accountId === accountId)?.t;
console.log(`账号=${accountId} 绑定页签 tabA=${tabA}`);

/* O1: A 的页签内 window.open 同站弹窗 → 自动继承 */
const tabAPage = ctx.pages().find((p) => p.url().includes('example.com'));
if (!tabAPage) { console.log('未找到 A 页签 Page'); process.exit(1); }
const [popup1] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }),
  tabAPage.evaluate(() => { window.open('https://example.com/?popup=1'); }),
]);
await popup1.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(1800);
const popup1TabId = await page.evaluate(async () => (await chrome.tabs.query({ url: '*://example.com/*' })).map((t) => t.id));
const bs1 = await bindingsOf();
const inherited = bs1.filter((b) => popup1TabId.includes(b.t));
console.log(`O1 同站弹窗 tabId=${JSON.stringify(popup1TabId)} 继承记录=${JSON.stringify(inherited)}`);
console.log(`O1 同站弹窗继承A: ${inherited.some((b) => b.accountId === accountId) ? '✔' : '✖'}`);

/* O2: 异域未授权弹窗 → 护栏解绑 */
const [popup2] = await Promise.all([
  ctx.waitForEvent('page', { timeout: 8000 }),
  tabAPage.evaluate(() => { window.open('https://example.org/foreign'); }),
]);
await popup2.waitForLoadState('domcontentloaded').catch(() => {});
await page.waitForTimeout(2500);
const popup2TabId = await page.evaluate(async () => (await chrome.tabs.query({ url: '*://example.org/*' })).map((t) => t.id));
const bs2 = await bindingsOf();
const leaked = bs2.filter((b) => popup2TabId.includes(b.t));
console.log(`O2 异域弹窗 tabId=${JSON.stringify(popup2TabId)} 绑定残留=${JSON.stringify(leaked)}`);
console.log(`O2 异域未授权弹窗被护栏解绑: ${popup2TabId.length && !leaked.length ? '✔' : '✖'}`);

/* O3: 手动新建页签（无 opener）→ 不继承 */
const manualTabId = await page.evaluate(() => new Promise((res) => chrome.tabs.create({ url: 'https://example.com/manual', active: false }, (t) => res(t.id))));
await page.waitForTimeout(1800);
const bs3 = await bindingsOf();
console.log(`O3 手动页签 tab=${manualTabId} 绑定=${JSON.stringify(bs3.filter((b) => b.t === manualTabId))}`);
console.log(`O3 手动页签不继承: ${!bs3.some((b) => b.t === manualTabId) ? '✔' : '✖'}`);

/* O4: A 原页签仍绑定 */
console.log(`O4 原页签保持绑定: ${bs3.some((b) => b.t === tabA && b.accountId === accountId) ? '✔' : '✖'}`);

/* O5: 继承弹窗的种子管道（bridge→MAIN→命名空间 localStorage）端到端畅通 */
console.log(`O5 弹窗 URL: ${popup1.url()}`);
const seedRes = await page.evaluate(async ({ tabId, accountId }) => {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ql:bridgeDown', payload: { op: 'bind', accountId, tabId, seed: { __auth_token__: 'TESTTOKEN-ABC123' } } });
    return { ok: true };
  } catch (e) {
    return { err: String(e).slice(0, 80) };
  }
}, { tabId: popup1TabId[1], accountId });
console.log(`O5 bridgeDown: ${JSON.stringify(seedRes)}`);
await popup1.waitForTimeout(600);
/* SPA 语义：读裸键 __auth_token__ → patch 重定向到命名空间 → 拿到 A 的 token */
const bareRead = await popup1.evaluate(() => localStorage.getItem('__auth_token__'));
console.log(`O5 裸键读(SPA 视角)=${JSON.stringify(bareRead)}`);
console.log(`O5 种子管道端到端: ${bareRead === 'TESTTOKEN-ABC123' ? '✔' : '✖'}`);

await ctx.close();
