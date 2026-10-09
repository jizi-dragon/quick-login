/** C: 修复验证——patch 后重新 create+open，观察自动登录全流程 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const mfPath = path.join(DIST, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
if (!mf.host_permissions.some((h) => h.includes('10.100.0.105'))) {
  mf.host_permissions.push('*://10.100.0.105/*');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) { for (const s of ['chrome-win64', 'chrome-win']) { const p = path.join(mp, d, s, 'chrome.exe'); if (fs.existsSync(p)) return p; } }
  return null;
}
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const extId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const profile = path.join(ROOT, 'tmp', 'ui-vpn-c');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(), headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);
const cr = await page.evaluate((s) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '10.100.0.105', tabName: '体验T01', username: s.u, password: s.p, open: false }), { u: 'T01', p: '88888888' });
const id = cr?.result?.data?.id;
console.log('[C1] par.create ok =', Boolean(id));
const op = await page.evaluate((i) => chrome.runtime.sendMessage({ kind: 'par.open', id: i }), id);
console.log('[C2] par.open:', JSON.stringify(op).slice(0, 120));
// 等自动登录全流程（填充+观察期+提交+跳转）
await page.waitForTimeout(18000);
const siteTab = ctx.pages().find((p) => p.url().includes('10.100.0.105'));
if (siteTab) {
  console.log(`[C3] 页签 URL = ${siteTab.url().slice(0, 90)}`);
  const bodyText = (await siteTab.evaluate(() => document.body.innerText).catch(() => '(evaluate失败)')).slice(0, 120).replace(/\n+/g, ' | ');
  console.log('[C4] 页面文本:', bodyText);
  await siteTab.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-c-success.png') }).catch(() => {});
  console.log('[C5] 截图 tmp/vpn-c-success.png');
  const cookies = await ctx.cookies('http://10.100.0.105');
  console.log('[C6] Cookie:', JSON.stringify(cookies.map((c) => ({ name: c.name, len: (c.value ?? '').length }))));
} else {
  console.log('[C3] 未找到站点页签，全部页签:', JSON.stringify(ctx.pages().map((p) => p.url().slice(0, 70))));
}
const list = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' }));
const acc = list?.result?.data?.accounts ?? list?.result?.data ?? [];
const rec = Array.isArray(acc) ? acc.find((a) => a.siteHost === '10.100.0.105') : acc;
console.log('[C7] 账号 hasToken =', rec?.hasToken ?? '(字段未返回)', JSON.stringify(rec).slice(0, 140));
const diag = await page.evaluate(async () => (await chrome.storage.local.get('ql:diag'))['ql:diag'] ?? []);
console.log('[C8] diag 关键:', JSON.stringify(diag.filter((l) => /open\(|登录|token|快照|syncAccountRules|异常/.test(l)).slice(-10), null, 1));
await ctx.close();
console.log('=== C 修复验证完成 ===');
