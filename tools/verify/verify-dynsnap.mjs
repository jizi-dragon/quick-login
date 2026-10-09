/** v3.10.6 验证：Cookie 快照动态化——登录后的服务端票据/页内写入实时进回放。
 *  模拟平台（qllocal.test → 127.0.0.1 自签 https）：
 *   登录 Set-Cookie sid（登录时点，静态快照可捕获）
 *   /api/download/apply → Set-Cookie dl_ticket（登录后票据——静态快照必缺，动态捕获应回放）
 *   /api/dl-rotate / /api/dl-clear → 票据轮换/作废语义
 *   页内 document.cookie 写入（袋回流通道）
 *  /download/file 记录每次请求的 Cookie 头，/__cookies 供断言。 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const mfPath = path.join(DIST, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
mf.host_permissions = ['*://example.com/*', '*://127.0.0.1/*']; // scheme=* 与 isEnforceable 的 contains 查询一致
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

const HOSTNAME = '127.0.0.1';
/* 自签证书：node webcrypto RSA-SHA256（TLS 兼容性无问题） */
x509.cryptoProvider.set(globalThis.crypto);
const certAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const certKeys = await globalThis.crypto.subtle.generateKey(certAlg, true, ['sign', 'verify']);
const certObj = await x509.X509CertificateGenerator.createSelfSigned({
  serial: '01', name: 'CN=qllocal.test',
  notBefore: new Date(Date.now() - 864e5), notAfter: new Date(Date.now() + 365 * 864e5),
  keys: certKeys, alg: certAlg,
  extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'qllocal.test' }, { type: 'ip', value: '127.0.0.1' }])],
});
const CERT_PEM = certObj.toString('pem');
const keyB64 = Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', certKeys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n');
const KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${keyB64}\n-----END PRIVATE KEY-----\n`;
const getJSON = (url) => new Promise((res, rej) => { const r = https.get(url, { rejectUnauthorized: false }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }); r.on('error', rej); });

/** 模拟平台服务端 */
const fileCookies = []; // 每次 /download/file 请求的 Cookie 头
const server = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, (req, res) => {
  const url = new URL(req.url ?? '/', `https://${HOSTNAME}`);
  const js = (body, headers = {}) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(body);
  };
  if (url.pathname === '/login') {
    js(`<!doctype html><html><body><script>
      fetch('/api/login', { method: 'POST' }).then(() => {
        localStorage.setItem('__auth_token__', 'h.${Buffer.from(JSON.stringify({ uid: 1, username: 'alice' })).toString('base64url')}.sA');
        localStorage.setItem('__auth_user__', JSON.stringify({ uid: 1, username: 'alice' }));
        document.title = 'LOGGED_IN';
      });
    </script>login page</body></html>`);
    return;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sid=SID_${Date.now()}; Path=/` });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/api/download/apply') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dl_ticket=TKT1; Path=/' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/api/dl-rotate') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dl_ticket=TKT2; Path=/' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/api/dl-clear') {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dl_ticket=; Max-Age=0; Path=/' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/download/file') {
    fileCookies.push(req.headers.cookie ?? '');
    const ok = (req.headers.cookie ?? '').includes('dl_ticket=');
    res.writeHead(ok ? 200 : 403, { 'content-type': 'text/plain' });
    res.end(ok ? 'FILEDATA' : 'DENIED');
    return;
  }
  if (url.pathname === '/__cookies') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fileCookies));
    return;
  }
  res.writeHead(404); res.end('nf');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(443, '127.0.0.1', resolve); // --host-resolver-rules 只解析不改端口：https 默认 443
});
const port = 443;

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
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`); };

const profile = path.join(ROOT, 'tmp', 'ui-dynsnap');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`,
    '--no-first-run', '--ignore-certificate-errors',
  ],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

const acc = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '127.0.0.1', tabName: 'A1', username: 'alice', password: 'pw', open: false }))).result.data;
console.log('  账号:', JSON.stringify(acc));
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
await sleep(2500);
console.log('  页面URL列表:', JSON.stringify(ctx.pages().map((p) => p.url())));
const tab = [...ctx.pages()].find((p) => p.url().startsWith(`https://${HOSTNAME}`));
if (!tab) { console.log('✖ 页签未打开'); process.exit(1); }

/* 等待 token 捕获（快照首捕完成） */
let diag = null;
for (let i = 0; i < 30; i++) {
  diag = (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' })))?.result?.data?.parallel;
  if (diag?.tokens?.some((t) => t.hasToken)) break;
  await sleep(500);
}
check('S1 登录完成且 token 捕获（快照首捕前提）', Boolean(diag?.tokens?.some((t) => t.hasToken)), JSON.stringify(diag?.tokens ?? []));

/* D1：登录后的下载票据（服务端 Set-Cookie）应实时进回放 */
await tab.evaluate(() => fetch('/api/download/apply'));
await sleep(1200);
await tab.evaluate(() => fetch('/download/file'));
await sleep(800);
let cookies = await getJSON(`https://127.0.0.1:${port}/__cookies`);
const last1 = cookies.at(-1) ?? '';
check('D1 登录后服务端票据实时进回放（下载不再被拒）', last1.includes('dl_ticket=TKT1'), `cookie="${last1.slice(0, 120)}"`);
check('D1b 登录时点 Cookie 仍在回放（sid）', last1.includes('sid=SID_'), '');

/* D2：票据轮换（值更新语义） */
await tab.evaluate(() => fetch('/api/dl-rotate'));
await sleep(1200);
await tab.evaluate(() => fetch('/download/file'));
await sleep(800);
const last2 = (await getJSON(`https://127.0.0.1:${port}/__cookies`)).at(-1) ?? '';
check('D2 票据轮换实时生效（回放值 TKT2）', last2.includes('dl_ticket=TKT2'), `cookie="${last2.slice(0, 120)}"`);

/* D3：服务端作废指令（Max-Age=0）→ 从回放移除 */
await tab.evaluate(() => fetch('/api/dl-clear'));
await sleep(1200);
await tab.evaluate(() => fetch('/download/file'));
await sleep(800);
const last3 = (await getJSON(`https://127.0.0.1:${port}/__cookies`)).at(-1) ?? '';
check('D3 服务端作废票据后回放同步移除', !last3.includes('dl_ticket='), `cookie="${last3.slice(0, 120)}"`);

/* E1：页内 JS document.cookie 写入（袋回流通道） */
await tab.evaluate(() => { document.cookie = 'jsck=JSVAL'; });
await sleep(1200); // 袋回流 300ms 节流 + 合并
await tab.evaluate(() => fetch('/download/file'));
await sleep(800);
const last4 = (await getJSON(`https://127.0.0.1:${port}/__cookies`)).at(-1) ?? '';
check('E1 页内写入的 Cookie 经袋回流进回放', last4.includes('jsck=JSVAL'), `cookie="${last4.slice(0, 120)}"`);
if (!last4.includes('jsck=JSVAL')) {
  const diagLog = await page.evaluate(async () => (await chrome.storage.local.get('ql:diag'))['ql:diag'] ?? []);
  console.log('  [诊断] 尾部:', JSON.stringify(diagLog.slice(-14), null, 1));
}

await ctx.close();
server.close();
console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
