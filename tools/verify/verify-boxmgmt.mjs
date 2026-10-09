/** 盒子重命名/删除 功能验证（v3.9.2） */
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
const profile = path.join(ROOT, 'tmp', 'ui-boxmgmt-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

// 建 3 账号：A/B 在「开发组」，C 在默认
const specs = ['开发组', '开发组', ''];
for (let i = 0; i < specs.length; i++) {
  const res = await page.evaluate(async ({ idx, box }) => {
    return chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: `账号${idx + 1}`, username: `u${idx}`, password: 'p', open: false, box: box || undefined });
  }, { idx: i, box: specs[i] });
  console.log(`create#${i}: ${JSON.stringify(res)?.slice(0, 120)}`);
}
await page.reload();
await page.waitForTimeout(900);
const tags = async () => page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
console.log(`初始: ${(await tags()).join(',')}`);

const acts = async () => page.evaluate(() =>
  [...document.querySelectorAll('#box-chips .chip')].map((c) => ({
    name: c.querySelector('span')?.textContent,
    rename: !!c.querySelector('.chip-act:not(.chip-act-del)'),
    del: !!c.querySelector('.chip-act-del'),
  })));
console.log(`chips 操作钮: ${JSON.stringify(await acts())}`);

/* ---- R1: 重命名 开发组 → 研发组（账号随迁） ---- */
page.on('dialog', (d) => d.accept('研发组'));
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '开发组');
  chip.querySelector('.chip-act').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(900);
console.log(`R1 重命名后: ${(await tags()).join(',')} ${JSON.stringify((await tags()).join(',') === '研发组,研发组,默认盒子') ? '✔' : '✖'}`);

/* ---- R2: 删除 研发组（2 账号回归默认） ---- */
page.removeAllListeners('dialog');
page.on('dialog', (d) => d.accept());
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '研发组');
  chip.querySelector('.chip-act-del').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(900);
console.log(`R2 删除后: ${(await tags()).join(',')} ${(await tags()).join(',') === '默认盒子,默认盒子,默认盒子' ? '✔' : '✖'}`);
const chips2 = await page.evaluate(() => [...document.querySelectorAll('#box-chips .chip span:first-child')].map((s) => s.textContent));
console.log(`R2 chips: ${chips2.join(' | ')} ${chips2.join('|') === '全部|默认盒子|＋ 新建盒子' ? '✔' : '✖'}`);

/* ---- R3: 冷启持久化 ---- */
await page.reload();
await page.waitForTimeout(900);
console.log(`R3 冷启后: ${(await tags()).join(',')} ${(await tags()).join(',') === '默认盒子,默认盒子,默认盒子' ? '✔' : '✖'}`);

/* ---- R4: 默认盒子无管理钮 ---- */
const defActs = await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '默认盒子');
  return { rename: !!chip.querySelector('.chip-act'), title: chip.title.includes('不可删除') };
});
console.log(`R4 默认盒子保护: ${JSON.stringify(defActs)} ${!defActs.rename && defActs.title ? '✔' : '✖'}`);

await ctx.close();
