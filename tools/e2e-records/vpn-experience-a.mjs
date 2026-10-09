/** A: 真实内网站点侦察——http://10.100.0.105/login 页面结构与登录体验（T01） */
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
const profile = path.join(ROOT, 'tmp', 'ui-vpn-recon');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, { executablePath: findPwChromium(), headless: true, args: ['--no-first-run'] });
const page = await ctx.newPage();
const t0 = Date.now();
try {
  await page.goto('http://10.100.0.105/login', { timeout: 20000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  console.log(`[A1] 页面加载成功 耗时=${Date.now() - t0}ms 最终URL=${page.url()} 标题=${await page.title()}`);
  // 表单结构侦察
  const inputs = await page.evaluate(() => [...document.querySelectorAll('input,button')].map((el) => ({
    tag: el.tagName, type: el.type ?? '', placeholder: el.placeholder ?? '', text: (el.textContent ?? '').trim().slice(0, 20), visible: !!(el.offsetWidth || el.offsetHeight),
  })));
  console.log('[A2] 表单元素:', JSON.stringify(inputs, null, 1));
  const iframes = await page.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => ({ src: (f.src || '').slice(0, 60), srcdoc: (f.srcdoc || '').slice(0, 60) })));
  console.log('[A3] iframe:', JSON.stringify(iframes));
  // 实际登录 T01
  const user = page.locator('input[placeholder="请输入用户名"], input[type="text"]').first();
  await user.fill('T01');
  const pw = page.locator('input[type="password"]').first();
  if (await pw.count()) await pw.fill('88888888');
  await page.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-recon-filled.png') });
  const btn = page.locator('button').filter({ hasText: /登\s*录|登录/ }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForTimeout(6000);
    console.log(`[A4] 登录提交后 URL=${page.url()} 标题=${await page.title()}`);
    await page.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-recon-after-login.png') });
    const cookies = await ctx.cookies('http://10.100.0.105');
    console.log('[A5] 登录后 Cookie:', JSON.stringify(cookies.map((c) => ({ name: c.name, secure: c.secure, len: (c.value ?? '').length }))));
    const ls = await page.evaluate(() => ({ token: (localStorage.getItem('__auth_token__') ?? '').slice(0, 30), user: (localStorage.getItem('__auth_user__') ?? '').slice(0, 60) }));
    console.log('[A6] localStorage:', JSON.stringify(ls));
  } else {
    console.log('[A4] 未找到登录按钮');
  }
} catch (e) {
  console.log(`[A失败] ${String(e).slice(0, 300)}`);
  await page.screenshot({ path: path.join(ROOT, 'tmp', 'vpn-recon-error.png') }).catch(() => {});
}
await ctx.close();
console.log('=== A 侦察完成 ===');
