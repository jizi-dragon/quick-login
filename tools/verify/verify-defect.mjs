/** v3.10.4 验证：继承页签进登录页自动转原始 + 稳定载荷异账号护栏 + 互不干扰 */
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

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const JWT_A = `h.${b64url({ uid: 1, username: 'alice' })}.sA`;
const JWT_A_ROT = `h.${b64url({ uid: 1, username: 'alice', exp: 999999 })}.sA2`; // 轮换：稳定载荷相同
const JWT_C = `h.${b64url({ uid: 3, username: 'carol' })}.sC`; // 异账号
const USER_A = JSON.stringify({ username: 'alice', uid: 1 });
const USER_B = JSON.stringify({ username: 'bob', uid: 2 });

const profile = path.join(ROOT, 'tmp', 'ui-defect4');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);
const diag = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' })))?.result?.data?.parallel;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`); };

/* 1. 快捷登录账号 A（绑定页签 tab1）→ 模拟登录完成 */
const acc = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'A1', username: 'a1', password: 'p', open: false }))).result.data;
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
await sleep(1500);
const tab1 = ctx.pages().find((p) => p.url().startsWith('https://example.com'));
for (let i = 0; i < 15; i++) {
  const seeded = await tab1.evaluate(() => localStorage.getItem('__ql_cookies__')).catch(() => null);
  if (seeded !== null) break;
  await sleep(400);
}
await tab1.evaluate(([t, u]) => { localStorage.setItem('__auth_token__', t); localStorage.setItem('__auth_user__', u); }, [JWT_A, USER_A]);
await sleep(1200);

/* 2. 平台从 A 的页面新开子页签（window.open 非登录 URL —— 配置弹窗场景，应保持继承） */
const [tab2] = await Promise.all([
  ctx.waitForEvent('page'),
  tab1.evaluate(() => window.open('https://example.com/', '_blank')),
]);
await tab2.waitForLoadState('domcontentloaded').catch(() => undefined);
await sleep(1800);
check('S1 平台弹窗子页签保持继承（配置弹窗场景不受影响）', (await diag()).bindings.length === 2);

/* 3. 用户在继承页签里手输网址进入登录页（复刻步骤2-3）→ 应自动转原始页签 */
await tab2.goto('https://example.com/login', { waitUntil: 'domcontentloaded' }).catch(() => undefined);
await sleep(2200); // onNavigation → unbind + reload
const d3 = await diag();
check('S2 继承页签进入登录页即自动解绑（转原始，先于账密输入）', d3.bindings.length === 1, `bindings=${JSON.stringify(d3.bindings.map((b) => b.t))}`);

/* 4. 用户在该（现为原始）页签正常登录 B：原生写入 */
let rawMode = false;
for (let i = 0; i < 15; i++) {
  const bare = await tab2.evaluate(() => localStorage.length === 0 || !localStorage.getItem('__auth_user__')).catch(() => false);
  if (bare) { rawMode = true; break; }
  await sleep(400);
}
await tab2.evaluate(([t, u]) => { try { localStorage.setItem('__auth_token__', t); localStorage.setItem('__auth_user__', u); } catch { /* */ } }, [JWT_A, USER_B]); // B 原生登录写真实存储
await sleep(800);
const d4 = await diag();
const tok4 = (d4.tokens ?? []).find((x) => x.id === acc.id);
const ns4 = await tab1.evaluate(() => ({ t: localStorage.getItem('__auth_token__'), u: localStorage.getItem('__auth_user__') }));
check('D1 B 的原生登录不触碰 A 的命名空间（user 无 bob）', !(ns4.u ?? '').includes('bob'));
check('D2 A 的快照 token 未被 B 污染', tok4?.hasToken === true);

/* 5. 轮换回归：同账号 token 轮换（仅时效字段变化）不触发叛逃 */
await tab1.evaluate((t) => localStorage.setItem('__auth_token__', t), JWT_A_ROT);
await sleep(1200);
const d5 = await diag();
check('D3 同账号 token 轮换正常更新（不误判叛逃）', d5.bindings.length === 1 && d5.bindings[0].t === d3.bindings[0].t);

/* 6. 兜底叛逃：原始绑定页签内直接登录异账号（无 /login 前兆）→ 处置 */
await tab1.evaluate((t) => localStorage.setItem('__auth_token__', t), JWT_C);
await sleep(2500);
const d6 = await diag();
const tok6 = (d6.tokens ?? []).find((x) => x.id === acc.id);
check('S3 原始绑定页签内异账号登录 → 叛逃解绑', d6.bindings.length === 0, `bindings=${JSON.stringify(d6.bindings.map((b) => b.t))}`);
check('D4 快照 token 未被异账号污染（护栏保留）', tok6?.hasToken === true);

/* 7. 关光页签重开 A：打开即愈 */
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
await sleep(2200);
const tabR = ctx.pages().filter((p) => p.url().startsWith('https://example.com')).pop();
const reopenedUser = await tabR.evaluate(() => localStorage.getItem('__auth_user__')).catch(() => 'ERR');
check('D5 重开 A 无残留用户身份（打开即愈）', reopenedUser === null || reopenedUser.includes('alice'), `user=${JSON.stringify(reopenedUser)}`);

await ctx.close();
console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
