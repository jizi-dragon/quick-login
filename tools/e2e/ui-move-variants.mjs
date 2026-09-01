/**
 * 移盒变体复现（ui-check 未覆盖的真实用户路径）：
 *  V1. 输入新盒子名 → 确定移入（一步创建+移入）
 *  V2. 在「某盒子」筛选视图下把账号移到另一个盒子
 *  V3. 移入后重开管理页（冷启读库）确认持久化
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const HOST = 'tonbridge-config.aksoegmp.com';

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
const profile = path.join(ROOT, 'tmp', 'ui-move-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(700);

// 建两个账号（都在默认盒子）
for (let i = 0; i < 2; i++) {
  await page.evaluate(async (idx) => {
    await chrome.runtime.sendMessage({
      kind: 'par.create', siteHost: 'tonbridge-config.aksoegmp.com',
      tabName: `账号${idx + 1}`, username: `u${idx}`, password: 'p', open: false,
    });
  }, i);
}
await page.reload();
await page.waitForTimeout(900);
const tags0 = await page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
console.log(`初始盒子标签: ${tags0.join(',')}`);

/* ---- V1: 输入新盒子名「测试盒」→ 确定移入 ---- */
await page.click('#batch-toggle');
await page.waitForTimeout(200);
await page.click('#browser-list .account-card:nth-child(1) .ac-check');
await page.click('#sel-move');
await page.waitForSelector('#box-modal:not(.hidden)', { timeout: 3000 });
await page.fill('#box-modal-new', '测试盒');
await page.waitForTimeout(150);
await page.click('#box-modal-ok');
await page.waitForTimeout(900);
const tags1 = await page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
const chips1 = await page.evaluate(() => [...document.querySelectorAll('#box-chips .chip')].map((c) => c.textContent?.replace(/\d+/g, '#')));
console.log(`V1 输入新名移入后 标签: ${tags1.join(',')} | chips: ${chips1.join(' | ')}`);
console.log(`V1 ${tags1[0] === '测试盒' && tags1[1] === '默认盒子' ? '✔ 通过' : '✖ 失败'}`);

/* ---- V2: 筛选到「测试盒」视图，把该账号移回默认盒子 ---- */
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.textContent?.includes('测试盒'));
  chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(400);
const cardsInFilter = await page.evaluate(() => document.querySelectorAll('#browser-list .account-card').length);
await page.click('#browser-list .account-card:nth-child(1) .ac-check');
await page.click('#sel-move');
await page.waitForSelector('#box-modal:not(.hidden)', { timeout: 3000 });
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#box-modal .box-option')];
  rows.find((r) => r.textContent?.includes('默认盒子'))?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.click('#box-modal-ok');
await page.waitForTimeout(900);
const view2 = await page.evaluate(() => ({
  cards: document.querySelectorAll('#browser-list .account-card').length,
  empty: !!document.querySelector('#browser-list .empty'),
  emptyTip: document.querySelector('#browser-list .empty div:last-child')?.textContent ?? '',
  allTags: [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent),
}));
console.log(`V2 筛选视图账号数=${cardsInFilter} → 移出后 视图内=${view2.cards} 空态=${view2.empty}`);
console.log(`V2 ${view2.cards === 0 && view2.empty ? '✔ 通过（账号已移出该筛选视图）' : '✖ 失败'}`);

/* ---- V3: 冷启重开管理页，验证持久化 ---- */
await page.reload();
await page.waitForTimeout(900);
const tags3 = await page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
console.log(`V3 冷启后盒子标签: ${tags3.join(',')}`);
console.log(`V3 ${tags3.join(',') === '默认盒子,默认盒子' ? '✔ 通过（持久化正确）' : '✖ 失败'}`);

await ctx.close();
