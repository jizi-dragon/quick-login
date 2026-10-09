/** 盒子轨道（120° 固定弧 + 节点）功能验证（v3.9.5） */
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
const profile = path.join(ROOT, 'tmp', 'ui-track-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

// 建 4 账号分 3 盒：A/B→开发组, C→默认盒, D→测试盒
const plan = [['A', '开发组'], ['B', '开发组'], ['C', ''], ['D', '测试盒']];
for (let i = 0; i < plan.length; i++) {
  await page.evaluate(({ idx, box }) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: `账号${idx + 1}`, username: `u${idx}`, password: 'p', open: false, box: box || undefined }), { idx: i, box: plan[i][1] });
}
await page.evaluate(() => chrome.storage.local.set({ 'ql:boxes': ['开发组', '测试盒'] }));
await page.reload();
await page.waitForTimeout(1000);

const wheelPage = await ctx.newPage();
await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
await wheelPage.waitForTimeout(1000);

const snap = () => wheelPage.evaluate(() => {
  const svg = document.querySelector('.sector-svg');
  const track = svg?.querySelector('.box-track');
  const nodes = [...(svg?.querySelectorAll('.box-node') ?? [])];
  const on = svg?.querySelector('.box-node-on');
  const cx = svg?.viewBox.baseVal.width / 2 ?? 260;
  const cy = cx;
  const pt = (el) => ({ x: +el.getAttribute('cx'), y: +el.getAttribute('cy') });
  const rOf = (el) => Math.hypot(+el.getAttribute('cx') - cx, +el.getAttribute('cy') - cy);
  return {
    track: track ? { d: track.getAttribute('d')?.slice(0, 30), stroke: getComputedStyle(track).strokeWidth } : null,
    nodeCount: nodes.length,
    activeR: on ? Math.hypot(+on.getAttribute('cx') - cx, +on.getAttribute('cy') - cy).toFixed(1) : null,
    activePos: on ? pt(on) : null,
    activeFill: on ? getComputedStyle(on).fill : null,
    oldArc: !!svg?.querySelector('.hub-arc'),
  };
});

let s = await snap();
console.log(`初始: 轨道=${JSON.stringify(s.track)} | 节点数=${s.nodeCount} | 高亮半径=${s.activeR} 高亮色=${s.activeFill} | 旧弧残留=${s.oldArc}`);
console.log(`T1 节点=3盒: ${s.nodeCount === 3 ? '✔' : '✖'} | 半径≈254: ${Math.abs(s.activeR - 254) < 1 ? '✔' : '✖'} | 高亮蓝: ${s.activeFill.includes('30,111,255') || s.activeFill.includes('1e6fff') ? '✔' : '✖'}`);
const firstPos = s.activePos;

/* 滚轮切盒 → 高亮节点应滑到下一节点位置 */
await wheelPage.evaluate(() => document.querySelector('.sector-wheel')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })));
await wheelPage.waitForTimeout(500);
s = await snap();
console.log(`切盒1: 高亮位置=${JSON.stringify(s.activePos)} Hub=${await wheelPage.evaluate(() => document.querySelector('.hub-box')?.textContent)}`);
console.log(`T2 高亮移动: ${JSON.stringify(s.activePos) !== JSON.stringify(firstPos) ? '✔' : '✖'} | 仍在轨道半径: ${Math.abs(s.activeR - 254) < 1 ? '✔' : '✖'}`);
const secondPos = s.activePos;

/* 连续滚两轮（循环）回第一个节点 */
await wheelPage.evaluate(() => document.querySelector('.sector-wheel')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })));
await wheelPage.waitForTimeout(400);
await wheelPage.evaluate(() => document.querySelector('.sector-wheel')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true })));
await wheelPage.waitForTimeout(500);
s = await snap();
console.log(`切盒2×2 循环回: 位置=${JSON.stringify(s.activePos)} ${JSON.stringify(s.activePos) === JSON.stringify(firstPos) ? '✔ 回到首节点' : '✖'}`);

/* 单盒场景：只留默认盒的账号 */
await page.evaluate(() => chrome.storage.local.set({ 'ql:boxes': [] }));
await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.deleteBox', name: '开发组' }));
await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.deleteBox', name: '测试盒' }));
await wheelPage.reload();
await wheelPage.waitForTimeout(1000);
s = await snap();
console.log(`单盒: 节点数=${s.nodeCount} 轨道=${s.track ? '存在' : '缺失'} 高亮=${JSON.stringify(s.activePos)}`);
console.log(`T4 单盒: ${s.nodeCount === 1 && s.track && Math.abs(+s.activePos.x - 514) < 1 ? '✔ (节点在弧正中 3 点钟方向)' : '✖'}`);

await ctx.close();
