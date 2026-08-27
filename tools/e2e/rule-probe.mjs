/**
 * DNR 规则格式探针 —— 用一次性临时档案加载 dist 扩展，直接测试三条规则
 * 的精确格式（逐条 + 批量）在该 Chromium 版本下是否可安装。
 * 不动 tmp/e2e-profile，可与 E2E 台架并行运行。
 *
 * 用法：node tools/e2e/rule-probe.mjs
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

const ALL_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script', 'stylesheet', 'image', 'font', 'media', 'other'];

const rules = [
  {
    name: 'COOKIE剥离',
    rule: {
      id: 900001,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
      condition: { resourceTypes: ALL_TYPES, requestDomains: [HOST], tabIds: [999999] },
    },
  },
  {
    name: 'AUTH改写',
    rule: {
      id: 900003,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Authorization', operation: 'set', value: 'Bearer x.y.z' }] },
      condition: { resourceTypes: ['xmlhttprequest', 'websocket', 'sub_frame'], requestDomains: [HOST], tabIds: [999999] },
    },
  },
  {
    name: 'CACHE分区(urlTransform·已知Chrome不支持)',
    rule: {
      id: 900002,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { urlTransform: { queryTransform: { setParams: { _qlck: 't999999' } } } },
      },
      condition: { resourceTypes: ['xmlhttprequest'], requestMethods: ['GET'], requestDomains: [HOST], tabIds: [999999] },
    },
  },
];

const profile = path.join(ROOT, 'tmp', 'rule-probe-profile');
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

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);

const result = await page.evaluate(
  async ({ rules: testRules }) => {
    const out = { individual: {}, batch: null, remaining: null };
    for (const t of testRules) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ addRules: [t.rule] });
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [t.rule.id] });
        out.individual[t.name] = 'OK';
      } catch (e) {
        out.individual[t.name] = String(e?.message ?? e);
      }
    }
    try {
      await chrome.declarativeNetRequest.updateSessionRules({ addRules: testRules.map((t) => t.rule) });
      out.batch = 'OK';
    } catch (e) {
      out.batch = String(e?.message ?? e);
    }
    out.remaining = (await chrome.declarativeNetRequest.getSessionRules()).length;
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: testRules.map((t) => t.rule.id) });
    return out;
  },
  { rules },
);

console.log('── 逐条安装 ──');
for (const [name, r] of Object.entries(result.individual)) {
  console.log(`${r === 'OK' ? '✔' : '✖'} ${name}: ${r}`);
}
console.log('── 批量安装（原子语义）──');
console.log(`${result.batch === 'OK' ? '✔' : '✖'} 三条同批: ${result.batch}`);
console.log(`── 批量失败后残留规则数：${result.remaining} ──`);

await ctx.close();
console.log('DONE');
