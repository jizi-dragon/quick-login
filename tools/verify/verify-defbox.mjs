/** 默认盒子重命名 功能验证（v3.9.4） */
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
const profile = path.join(ROOT, 'tmp', 'ui-defbox-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

// 2 个未归盒账号（都属默认盒子）
for (let i = 0; i < 2; i++) {
  const r = await page.evaluate((idx) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: `账号${idx + 1}`, username: `u${idx}`, password: 'p', open: false }), i);
  if (!r?.result?.ok) { console.log('建号失败:', JSON.stringify(r)); process.exit(1); }
}
await page.reload();
await page.waitForTimeout(900);
const tags = () => page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
console.log(`初始: ${(await tags()).join(',')}`);

/* ---- D1: 默认盒子改名「我的主场」→ 未归盒账号跟随显示 ---- */
await page.evaluate(() => {
  window.prompt = () => '我的主场';
});
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '默认盒子');
  chip.querySelector('.chip-act').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);
console.log(`D1 改名后 tags: ${(await tags()).join(',')} ${(await tags()).join(',') === '我的主场,我的主场' ? '✔' : '✖'}`);
const chipNames1 = await page.evaluate(() => [...document.querySelectorAll('#box-chips .chip span:first-child')].map((s) => s.textContent));
console.log(`D1 chips: ${chipNames1.filter(Boolean).join(' | ')} ${chipNames1.includes('我的主场') && !chipNames1.includes('默认盒子') ? '✔' : '✖'}`);

/* ---- D2: 新建账号（不带 box）→ 落入「我的主场」 ---- */
await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: '账号3', username: 'u3', password: 'p', open: false }));
await page.waitForTimeout(1200);
console.log(`D2 新账号归属: ${(await tags()).join(',')} ${(await tags()).join(',') === '我的主场,我的主场,我的主场' ? '✔' : '✖'}`);

/* ---- D3: 冷启持久化 ---- */
await page.reload();
await page.waitForTimeout(900);
console.log(`D3 冷启 tags: ${(await tags()).join(',')} ${(await tags()).join(',') === '我的主场,我的主场,我的主场' ? '✔' : '✖'}`);

/* ---- D4: 轮盘同步（Hub 显示「我的主场」） ---- */
await page.evaluate(() => chrome.storage.local.set({ 'ql:boxes': ['研发组'] }));
const wheelPage = await ctx.newPage();
await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
await wheelPage.waitForTimeout(900);
const hub = await wheelPage.evaluate(() => document.querySelector('.hub-box')?.textContent ?? '');
console.log(`D4 轮盘 Hub: ${hub} ${hub === '我的主场' ? '✔' : '✖'}`);

/* ---- D5: 默认盒不可删除（无 ✕ 钮），普通盒两者皆有（等一次 3s 轮询确保研发组入列） ---- */
await page.waitForTimeout(3500);
const acts = await page.evaluate(() => {
  const out = {};
  for (const c of document.querySelectorAll('#box-chips .chip')) {
    const n = c.querySelector('span')?.textContent;
    if (n === '我的主场' || n === '研发组') out[n] = { rename: !!c.querySelector('.chip-act:not(.chip-act-del)'), del: !!c.querySelector('.chip-act-del') };
  }
  return out;
});
console.log(`D5 操作钮: ${JSON.stringify(acts)} ${acts['我的主场']?.rename && !acts['我的主场']?.del && acts['研发组']?.rename && acts['研发组']?.del ? '✔' : '✖'}`);

await ctx.close();
