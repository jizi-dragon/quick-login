/**
 * UI 结构自动检查（v3.9.1）——不依赖人工目检：
 *  1) 并行管理页：品牌头/统计/盒子 chips/批量工具条/导入面板/空态齐备；
 *  2) 弹窗：仅「打开并行管理页」，统计条存在；
 *  3) 移入盒子：选择弹窗列出实际存在的盒子（默认盒子/管理组 + 计数），确认后盒子标签联动；
 *  4) 轮盘：单环 = 当前盒子账号、Hub 盒名、进度弧、滚轮切盒（含空盒子页可达）、无窗口控件。
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
  verChip: document.getElementById('ver-chip')?.textContent ?? '',
}));
check('管理页：品牌头 + 统计(含盒子) + 盒子chips + 批量/导入 + 表单齐备',
  emptyState.hasHeader && emptyState.hasStats && emptyState.hasChips && emptyState.hasBatchToggle && emptyState.hasImport && emptyState.hasForm,
  `ver=${emptyState.verChip}`);
check('管理页：空态提示渲染', emptyState.emptyShown);

/* ---- 2. 弹窗 ---- */
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

/* ---- 3. 程序化创建 3 个账号（管理组×2 + 默认盒子×1） ---- */
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

await extPage.reload();
await extPage.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 900));
const listState = await extPage.evaluate(() => ({
  cards: document.querySelectorAll('#browser-list .account-card').length,
  boxes: document.getElementById('stat-boxes')?.textContent ?? '',
  chips: [...document.querySelectorAll('#box-chips .chip')].map((c) => c.textContent?.replace(/\d+/g, '#')),
  boxTags: [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent),
  badges: [...document.querySelectorAll('#browser-list .badge')].map((b) => b.textContent),
}));
check('管理页：3 张账号卡片 + 盒子统计 = 2', listState.cards === 3 && listState.boxes === '2',
  `cards=${listState.cards} boxes=${listState.boxes}`);
check('管理页：盒子 chips（全部/默认盒子/管理组/＋新建）',
  listState.chips.length === 4 && listState.chips.some((c) => c?.includes('管理组')) && listState.chips.some((c) => c?.includes('新建')),
  listState.chips.join(' | '));
check('管理页：卡片显示盒子标签', listState.boxTags.join(',') === '管理组,管理组,默认盒子', listState.boxTags.join(','));
check('管理页：状态徽标（未授权·已暂停）', listState.badges.every((t) => t?.includes('未授权')), listState.badges.join(','));

/* ---- 4. 移入盒子：选择弹窗（列出实际存在的盒子） ---- */
await extPage.click('#batch-toggle');
await extPage.waitForTimeout(200);
await extPage.click('#browser-list .account-card:nth-child(1) .ac-check');
await extPage.click('#sel-move');
await extPage.waitForSelector('#box-modal:not(.hidden)', { timeout: 3000 });
const modalState = await extPage.evaluate(() => ({
  visible: !document.getElementById('box-modal')?.classList.contains('hidden'),
  options: [...document.querySelectorAll('#box-modal .box-option')].map((o) => o.textContent?.replace(/\d+/g, '#')),
  active: document.querySelector('#box-modal .box-option.active')?.textContent?.replace(/\d+/g, '#') ?? '',
}));
check('移盒弹窗：打开并列出实际盒子', modalState.visible && modalState.options.length === 2, modalState.options.join(' | '));
check('移盒弹窗：默认选中该账号当前盒子', modalState.active?.includes('管理组'), modalState.active);
// 选「默认盒子」并确认
await extPage.evaluate(() => {
  const rows = [...document.querySelectorAll('#box-modal .box-option')];
  const target = rows.find((r) => r.textContent?.includes('默认盒子'));
  target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await extPage.click('#box-modal-ok');
await extPage.waitForTimeout(900);
const afterMove = await extPage.evaluate(
  () => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent),
);
check('移盒弹窗：确认后盒子标签联动', afterMove.join(',') === '默认盒子,管理组,默认盒子', afterMove.join(','));

/* ---- 5. 轮盘：Hub 切盒 + 空盒子页可达 ---- */
// 预置一个记忆的空盒子「研发组」（模拟用户在管理页新建的空盒子）
await extPage.evaluate(async () => {
  await chrome.storage.local.set({ 'ql:boxes': ['研发组'] });
});
const wheelPage = await ctx.newPage();
await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
await wheelPage.waitForLoadState('domcontentloaded');
await new Promise((r) => setTimeout(r, 900));
const wheelState = await wheelPage.evaluate(() => {
  const sectors = [...document.querySelectorAll('.sector-wheel g.sector')];
  const hubBox = document.querySelector('.hub-box')?.textContent ?? '';
  const labels = [...document.querySelectorAll('.sector-label')].map((t) => t.textContent);
  const arc = document.querySelector('.hub-arc');
  const arcDash = arc?.getAttribute('stroke-dasharray') ?? '';
  return { sectorCount: sectors.length, hubBox, labels, arcDash };
});
check('轮盘：第 1 页 = 默认盒子（2 扇区：管理员A/普通用户U）',
  wheelState.sectorCount === 2 && wheelState.hubBox === '默认盒子' && wheelState.labels.join(',') === '管理员A,普通用户U',
  `sectors=${wheelState.sectorCount} box=${wheelState.hubBox} labels=${wheelState.labels.join(',')}`);
check('轮盘：进度弧 = 1/3', /^53[0-9]\.\d+ /.test(wheelState.arcDash), wheelState.arcDash);

// 滚轮切盒 ×1 → 管理组
await wheelPage.evaluate(() => {
  document.querySelector('.sector-wheel')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
});
await wheelPage.waitForTimeout(700);
const page2 = await wheelPage.evaluate(() => {
  const sectors = [...document.querySelectorAll('.sector-wheel g.sector')];
  return {
    sectorCount: sectors.length,
    hubBox: document.querySelector('.hub-box')?.textContent ?? '',
    labels: [...document.querySelectorAll('.sector-label')].map((t) => t.textContent),
    nums: [...document.querySelectorAll('.sector-num text')].map((t) => t.textContent),
  };
});
check('轮盘：滚轮切盒 → 管理组（1 扇区·管理员B·序号1）',
  page2.sectorCount === 1 && page2.hubBox === '管理组' && page2.labels.join(',') === '管理员B' && page2.nums.join(',') === '1',
  `box=${page2.hubBox} labels=${page2.labels.join(',')}`);

// 滚轮再切 ×1 → 空盒子「研发组」可达（BUG-1 修复验证）
await wheelPage.evaluate(() => {
  document.querySelector('.sector-wheel')?.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
});
await wheelPage.waitForTimeout(700);
const page3 = await wheelPage.evaluate(() => ({
  sectorCount: document.querySelectorAll('.sector-wheel g.sector').length,
  cap: document.querySelector('.hub-cap')?.textContent ?? '',
  sub: document.querySelector('.hub-sub')?.textContent ?? '',
}));
check('轮盘：空盒子「研发组」可达（0 扇区 + 盒名提示）',
  page3.sectorCount === 0 && page3.cap === '研发组' && page3.sub.includes('该盒子暂无账号'),
  `box=${page3.cap} sectors=${page3.sectorCount} sub=${page3.sub}`);

const noControls = await wheelPage.evaluate(
  () => !document.querySelector('.close-btn') && !document.querySelector('#close'),
);
check('轮盘：无窗口控制按钮', noControls);

const failed = results.filter((r) => !r.ok);
console.log(`\n── ${results.length - failed.length}/${results.length} 项通过 ──`);
await ctx.close();
process.exit(failed.length ? 1 : 0);
