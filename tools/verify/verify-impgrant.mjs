/** v3.10.1 定向验证：导入授权失败路径明确告警 + 账号照常创建 */
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

const mkCtx = async (tag) => {
  const profile = path.join(ROOT, 'tmp', `ui-imp-grant-${tag}`);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  return chromium.launchPersistentContext(profile, {
    executablePath: findPwChromium(),
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
  });
};

/* ---- 源：建号 + 导出（sites 含 example.com） ---- */
const ctxA = await mkCtx('src');
const pa = await ctxA.newPage();
await pa.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await pa.waitForTimeout(800);
await pa.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'Src1', username: 's1', password: 'p', open: false }));
const [download] = await Promise.all([
  pa.waitForEvent('download', { timeout: 8000 }),
  pa.evaluate(() => document.getElementById('data-export').click()),
]);
const backupPath = path.join(ROOT, 'tmp', 'imp-grant-backup.json');
await download.saveAs(backupPath);
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
backup.sites = ['bad^host']; // 非法 origin → request 快速抛错（headless 无法批准真实弹窗，用异常路径验证拒绝分支）
fs.writeFileSync(backupPath, JSON.stringify(backup));
console.log(`源导出: sites=${JSON.stringify(backup.sites)} 账号=${backup.accounts.length}`);
await ctxA.close();

/* ---- 目标：全新扩展导入（headless 授权必拒）→ 应明确提示补授 ---- */
const ctxB = await mkCtx('dst');
const pb = await ctxB.newPage();
await pb.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await pb.waitForTimeout(800);
const dialogs = [];
pb.on('dialog', (d) => { dialogs.push(`${d.type()}:${d.message().slice(0, 60)}`); void d.accept(); });
await pb.setInputFiles('#data-import-file', backupPath);
await pb.waitForTimeout(2500);
console.log(`对话框流: ${JSON.stringify(dialogs)}`);
const list = (await pb.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' })))?.result?.data ?? [];
const off = list.map((a) => a.enforcementOff);
console.log(`目标账号=${list.length} enforcementOff=${JSON.stringify(off)}`);
const alerted = dialogs.some((t) => t.includes('站点授权未完成'));
console.log(`V1 导入仍成功(账号=1): ${list.length === 1 ? '✔' : '✖'}`);
console.log(`V2 授权失败明确告警(不再静默): ${alerted ? '✔' : '✖'}`);
console.log(`V3 未授权状态如实显示(enforcementOff=true): ${off.every((o) => o === true) ? '✔' : '✖'}`);
await ctxB.close();
