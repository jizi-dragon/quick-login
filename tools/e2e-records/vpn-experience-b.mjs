/** B: Akso Pass 扩展全流程复现——预期 https 硬编码导致打开失败 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
// manifest 临时授权 10.100.0.105（真实用户走「添加并授权」，等效）
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
import { createHash } from 'node:crypto';
const profile = path.join(ROOT, 'tmp', 'ui-vpn-b');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(), headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);
// 创建账号（站点=10.100.0.105，真实凭证 T01）
const cr = await page.evaluate((s) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '10.100.0.105', tabName: '体验T01', username: s.u, password: s.p, open: false }), { u: 'T01', p: '88888888' });
console.log('[B1] par.create:', JSON.stringify(cr).slice(0, 160));
const id = cr?.result?.data?.id;
if (!id) throw new Error('create 失败');
// 打开
const op = await page.evaluate((i) => chrome.runtime.sendMessage({ kind: 'par.open', id: i }), id);
console.log('[B2] par.open:', JSON.stringify(op).slice(0, 160));
await page.waitForTimeout(7000);
// 检查打开的页签
const tabs = ctx.pages().map((p) => ({ url: p.url().slice(0, 90), title: '' }));
for (const p of ctx.pages()) {
  if (p.url().includes('10.100.0.105')) {
    let title = '';
    try { title = await p.title(); } catch { title = '(无法读取——错误页)'; }
    p.url && (tabs.push({ url: p.url().slice(0, 90), title }));
  }
}
console.log('[B3] 页签状态:', JSON.stringify(tabs, null, 1));
for (const p of ctx.pages()) {
  if (p.url().includes('10.100.0.105')) {
    await p.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-b-fail-tab.png') }).catch(() => {});
    console.log('[B4] 失败页签截图已存 tmp/vpn-b-fail-tab.png');
  }
}
// diag
const diag = await page.evaluate(async () => (await chrome.storage.local.get('ql:diag'))['ql:diag'] ?? []);
console.log('[B5] diag 尾部:', JSON.stringify(diag.filter((l) => /open\(|bind|注入|异常/.test(l)).slice(-8)));
// 账号状态（hasToken 应为 false——登录没发生）
const list = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' }));
console.log('[B6] 账号状态:', JSON.stringify(list?.result?.data?.accounts?.map?.((a) => ({ name: a.tabName, hasToken: a.hasToken })) ?? list?.result?.data ?? []).slice(0, 200));
await ctx.close();
console.log('=== B 复现完成 ===');
