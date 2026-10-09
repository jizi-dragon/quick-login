/** A2: 修正 iframe 密码框填充后的真实登录体验 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) { for (const s of ['chrome-win64', 'chrome-win']) { const p = path.join(mp, d, s, 'chrome.exe'); if (fs.existsSync(p)) return p; } }
  return null;
}
const profile = path.join(ROOT, 'tmp', 'ui-vpn-recon2');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, { executablePath: findPwChromium(), headless: true, args: ['--no-first-run'] });
const page = await ctx.newPage();
await page.goto('http://10.100.0.105/login', { timeout: 20000, waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
// 主 frame 填用户名
await page.locator('input[placeholder="请输入用户名"]').first().fill('T01');
// srcdoc iframe 填密码
const frames = page.frames();
let pwFilled = false;
for (const f of frames) {
  if (f === page.mainFrame()) continue;
  const pw = f.locator('input[type="password"]');
  if (await pw.count()) {
    await pw.first().fill('88888888', { timeout: 5000 });
    pwFilled = true;
    console.log(`[B1] 密码已填入 iframe url=${(f.url() || 'srcdoc').slice(0, 40)}`);
    break;
  }
}
if (!pwFilled) console.log('[B1] 未找到密码 iframe');
// 勾选协议
const cb = page.locator('input[type="checkbox"]').first();
if (await cb.count()) {
  if (!(await cb.isChecked())) await cb.check().catch(async () => { await cb.click(); });
  console.log('[B2] 协议已勾选');
}
await page.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-recon2-filled.png') });
await page.locator('button').filter({ hasText: /登\s*录/ }).first().click();
await page.waitForTimeout(8000);
console.log(`[B3] 提交后 URL=${page.url()}`);
const cookies = await ctx.cookies('http://10.100.0.105');
console.log('[B4] Cookie:', JSON.stringify(cookies.map((c) => ({ name: c.name, secure: c.secure, len: (c.value ?? '').length }))));
const ls = await page.evaluate(() => ({ token: (localStorage.getItem('__auth_token__') ?? '').slice(0, 24), user: (localStorage.getItem('__auth_user__') ?? '').slice(0, 60) }));
console.log('[B5] localStorage:', JSON.stringify(ls));
const bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' | ');
console.log('[B6] 页面文本:', bodyText);
await page.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-recon2-after.png') });
await ctx.close();
console.log('=== A2 完成 ===');
