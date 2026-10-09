/** v3.10.2 会话卫生验证：原始登录与快速登录互不顶号（真实 jar 无扩展会话残留） */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');

// 临时给 dist manifest 加 example.com host 权限（headless 无法走 optional 授权弹窗；
// cookies API 需要 host 权限）。dist 不入库，结束后由 build.mjs 重建干净产物。
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

const profile = path.join(ROOT, 'tmp', 'ui-jar-hygiene');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);
const jar = () => page.evaluate(() => chrome.cookies.getAll({ url: 'https://example.com/' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1. 登录前基线：jar 里已有一枚「原始会话」Cookie（模拟用户既有登录态/平台 Cookie） */
await page.evaluate(() => chrome.cookies.set({ url: 'https://example.com/', name: 'R_raw_session', value: 'v0-baseline' }));

/* 2. 建号 + 快速登录打开（open 内部先记 preJar 基线再建页签） */
const acc = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'A1', username: 'a1', password: 'p', open: false }))).result.data;
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
await sleep(1500); // 页签导航 + 绑定 + 桥就绪

/* 3. 模拟 A 登录响应 Set-Cookie（真实登录时此 Cookie 由站点响应写入 jar） */
await page.evaluate(() => chrome.cookies.set({ url: 'https://example.com/', name: 'S_login_session', value: 'v1-accountA' }));

/* 4. 触发登录完成：页面写 token（patched localStorage → 桥上报 → captureToken → 快照 → 差集清扫） */
const aTab = page.context().pages().find((p) => p.url().startsWith('https://example.com'));
if (!aTab) throw new Error('找不到 example.com 页签');
await aTab.evaluate(() => localStorage.setItem('__auth_token__', 'eyJhbGciOiJIUzI1NiJ9.eyJ1aWQiOjF9.c2ln'));
await sleep(2000);

/* 5. 断言：扩展会话被清扫，原始基线保留 */
const afterSweep = await jar();
const names = afterSweep.map((c) => c.name).sort();
console.log(`清扫后 jar: ${JSON.stringify(names)}`);
console.log(`J1 扩展登录 Cookie 已从真实 jar 清除: ${names.includes('S_login_session') ? '✖' : '✔'}`);
console.log(`J2 登录前已存在的原始 Cookie 保留: ${names.includes('R_raw_session') ? '✔' : '✖'}`);

/* 6. onChanged 驱逐：扩展会话重入 jar → 立即移除 */
await page.evaluate(() => chrome.cookies.set({ url: 'https://example.com/', name: 'S_login_session', value: 'v1-accountA' }));
await sleep(1200);
const afterEvict = (await jar()).map((c) => c.name).sort();
console.log(`J3 重入的扩展会话被持续驱逐: ${afterEvict.includes('S_login_session') ? '✖' : '✔'}`);

/* 7. 非扩展会话不受影响：用户在原始页签登录 B 写入全新会话 → 存活 */
await page.evaluate(() => chrome.cookies.set({ url: 'https://example.com/', name: 'B_raw_newlogin', value: 'v2-userB' }));
await sleep(1200);
const afterB = (await jar()).map((c) => c.name).sort();
console.log(`J4 用户原始登录的新会话不受影响: ${afterB.includes('B_raw_newlogin') ? '✔' : '✖'}`);

/* 8. 快照回放内容不受清扫影响（快照含登录 Cookie 供绑定页签回放） */
const diag = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' }))).result.data.parallel;
const hasToken = diag.tokenAccounts?.includes(acc.id);
console.log(`J5 账号 token/快照正常捕获: ${hasToken ? '✔' : '✖'}`);

await ctx.close();
const pass = ['J1', 'J2', 'J3', 'J4', 'J5'].every(Boolean);
console.log(pass ? '=== 5/5 全部通过 ===' : '=== 存在失败 ===');
