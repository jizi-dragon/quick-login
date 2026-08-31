/**
 * UI 结构自动检查（v3.9 盒子/批量/导入/Hub 切盒）——不依赖人工目检：
 *  1) 并行管理页：品牌头/统计/盒子 chips/批量工具条/导入面板/空态齐备；
 *     建号（含盒子归属）后卡片渲染、统计联动、chips 计数联动；
 *  2) 弹窗：仅「打开并行管理页」一个操作（无轮盘/授权按钮），统计条存在；
 *  3) 轮盘：单环 = 当前盒子账号（扇区数/标签/序号），Hub 显示盒子名，
 *     进度弧存在，滚轮切盒后扇区与 Hub 联动，无窗口控制按钮。
 *
 * 用法：node tools/e2e/ui-check.mjs
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
  if (!fs.existsSync(mp)) {
    return null;
  }
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) {
        return p;
      }
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
const profile = path.join(ROOT, 'tmp', 'ui-check-profile');
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {
  // 忽略
}

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME_PATH ?? findPwChromium(),
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ' —— ' + detail : ''}`);
};

const extPage = await ctx.newPage();
await extPage.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);

/* ---- 1. 并行管理页（空态） ---- */
await extPage.waitForLoadState('domcontentloaded');
await extPage.waitForSelector('#browser-list .empty', { timeout: 5000 }).catch(() => undefined);
const emptyState = await extPage.evaluate(() => ({
  hasHeader: !!document.querySelector('.head .brand-ring'),
  hasStats: !!document.getElementById('stat-accounts') && !!document.getElementById('stat-online') && !!document.getElementById('stat-boxes'),
  emptyShown: !!document.querySelector('#browser-list .empty'),
  hasChips: !!document.querySelector('#box-chips .chip'),
  hasBatchToggle: !!document.getElementById('batch-toggle'),
  hasImport: !!document.getElementById('import-toggle') && !!document.getElementById('import-panel'),
  hasForm: ['p-host', 'p-box', 'p-tabname', 'p-username', 'p-password', 'add-only'].every((id) => !!document.getElementById(id)),
  hasSiteForm: !!document.getElementById('site-form') && !!document.getElementById('site-list'),
  verChip: document.getElementById('ver-chip')?.textContent ?? '',
}));
check('管理页：品牌头 + 统计(含盒子) + 盒子chips + 批量/导入 + 表单齐备',
  emptyState.hasHeader && emptyState.hasStats && emptyState.hasChips && emptyState.hasBatchToggle && emptyState.hasImport && emptyState.hasForm && emptyState.hasSiteForm,
  `ver=${emptyState.verChip}`);
check('管理页：空态提示渲染', emptyState.emptyShown);

/* ---- 2. 弹窗（作为标签页打开检查结构） ---- */
const popPage = await ctx.newPage();
await popPage.goto(`chrome-extension://${extId}/ui/popup/popup.html`);
await popPage.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 600));
const popupState = await popPage.evaluate(() => ({
  launch: !!document.getElementById('open-parallel'),
  noWheelBtn: !document.getElementById('open-wheel'),
  noGrantBtn: !document.getElementById('grant-site'),
  stats: ['stat-accounts', 'stat-online', 'stat-sites'].every((id) => !!document.getElementById(id)),
  ver: document.getElementById('ext-version')?.textContent ?? '',
}));
check('弹窗：仅保留「打开并行管理页」', popupState.launch && popupState.noWheelBtn && popupState.noGrantBtn);
check('弹窗：统计条（账号/在线/授权站点）+ 版本', popupState.stats && popupState.ver.length > 0, popupState.ver);

/* ---- 3. 程序化创建 3 个账号（2 个入「管理组」盒子，1 个默认盒子） ---- */
for (const [i, spec] of [['管理员A', '管理组'], ['管理员B', '管理组'], ['普通用户U', '']].entries()) {
  await extPage.evaluate(
    async ({ host, name, box, idx }) => {
      await chrome.runtime.sendMessage({
        kind: 'par.create',
        siteHost: host,
        tabName: name,
        username: `user${idx}`,
        password: 'pass',
        open: false,
        box: box || undefined,
      });
    },
    { host: HOST, name: spec[0], box: spec[1], idx: i },
  );
}

/* ---- 4. 管理页：卡片 + 统计 + chips 联动 ---- */
await extPage.reload();
await extPage.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 900));
const listState = await extPage.evaluate(() => ({
  cards: document.querySelectorAll('#browser-list .account-card').length,
  accounts: document.getElementById('stat-accounts')?.textContent ?? '',
  boxes: document.getElementById('stat-boxes')?.textContent ?? '',
  chips: [...document.querySelectorAll('#box-chips .chip')].map((c) => c.textContent?.replace(/\d+/g, '#')),
  boxTags: [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent),
  badges: [...document.querySelectorAll('#browser-list .badge')].map((b) => b.textContent),
}));
check('管理页：3 张账号卡片渲染', listState.cards === 3, `cards=${listState.cards}`);
check('管理页：盒子统计 = 2', listState.boxes === '2', `stat=${listState.boxes}`);
check('管理页：盒子 chips（全部/默认盒子/管理组/＋新建）',
  listState.chips.length === 4 && listState.chips[0]?.startsWith('全部') && listState.chips.some((c) => c?.includes('管理组')) && listState.chips.some((c) => c?.includes('新建')),
  listState.chips.join(' | '));
check('管理页：卡片显示盒子标签', listState.boxTags.join(',') === '管理组,管理组,默认盒子', listState.boxTags.join(','));
check('管理页：状态徽标（未授权·已暂停）', listState.badges.every((t) => t?.includes('未授权')), listState.badges.join(','));

/* ---- 5. 轮盘：Hub 切盒 ---- */
const wheelPage = await ctx.newPage();
await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
await wheelPage.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 900));
const wheelState = await wheelPage.evaluate(() => {
  const sectors = [...document.querySelectorAll('.sector-wheel g.sector')];
  const hubBox = document.querySelector('.hub-box')?.textContent ?? '';
  const hubNum = document.querySelector('.hub-num')?.textContent ?? '';
  const labels = [...document.querySelectorAll('.sector-label')].map((t) => t.textContent);
  const arc = document.querySelector('.hub-arc');
  const arcDash = arc?.getAttribute('stroke-dasharray') ?? '';
  // 滚轮切盒（核心在 root 上监听 wheel）
  const root = document.querySelector('.sector-wheel');
  root?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  return { sectorCount: sectors.length, hubBox, hubNum: hubNum.replace(/\s+/g, ''), labels, arcDash };
});
check('轮盘：单环显示当前盒子（管理组 → 2 扇区）', wheelState.sectorCount === 2, `sectors=${wheelState.sectorCount}`);
check('轮盘：Hub 显示盒子名', wheelState.hubBox === '管理组', wheelState.hubBox);
check('轮盘：Hub 汇总（0/2 在线）', wheelState.hubNum.includes('/2'), wheelState.hubNum);
check('轮盘：扇区显示当前盒子页签名', wheelState.labels.join(',') === '管理员A,管理员B', wheelState.labels.join(','));
check('轮盘：进度弧存在且有进度值', wheelState.arcDash.length > 0 && !wheelState.arcDash.startsWith('0 '), wheelState.arcDash);

await new Promise((r) => setTimeout(r, 700)); // 等切盒重渲染
const wheelState2 = await wheelPage.evaluate(() => {
  const sectors = [...document.querySelectorAll('.sector-wheel g.sector')];
  const hubBox = document.querySelector('.hub-box')?.textContent ?? '';
  const labels = [...document.querySelectorAll('.sector-label')].map((t) => t.textContent);
  const nums = [...document.querySelectorAll('.sector-num text')].map((t) => t.textContent);
  return { sectorCount: sectors.length, hubBox, labels, nums };
});
check('轮盘：滚轮切盒 → 默认盒子（1 扇区）', wheelState2.sectorCount === 1 && wheelState2.hubBox === '默认盒子',
  `sectors=${wheelState2.sectorCount} box=${wheelState2.hubBox}`);
check('轮盘：切盒后扇区与序号正确', wheelState2.labels.join(',') === '普通用户U' && wheelState2.nums.join(',') === '1',
  `${wheelState2.labels.join(',')} | ${wheelState2.nums.join(',')}`);

const noControls = await wheelPage.evaluate(
  () => !document.querySelector('.close-btn') && !document.querySelector('#close'),
);
check('轮盘：无窗口控制按钮', noControls);

const failed = results.filter((r) => !r.ok);
console.log(`\n── ${results.length - failed.length}/${results.length} 项通过 ──`);
await ctx.close();
process.exit(failed.length ? 1 : 0);
