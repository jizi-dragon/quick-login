/** v3.10.7 验证：自动登录节奏门控。
 *  A 齐备门槛：密码 iframe 延迟挂载 → 绝不空密码提交（首 POST 时间 > 挂载时间 且 p 正确）
 *  B 重渲染清值自愈：点击被服务端拒 + 页面中途清空密码 → 重填后再次提交成功
 *  C 用户点击接管：用户在填充完成前 trusted 点击 → 自动流程停手（POST 总数 1）
 *  D 失败感知：服务端连续拒绝（错误提示出现）→ 最多一次重填重试后让位（POST ≤ 2） */
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
mf.host_permissions = ['*://example.com/*', '*://127.0.0.1/*'];
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

const HOSTNAME = '127.0.0.1';
x509.cryptoProvider.set(globalThis.crypto);
const certAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const certKeys = await globalThis.crypto.subtle.generateKey(certAlg, true, ['sign', 'verify']);
const certObj = await x509.X509CertificateGenerator.createSelfSigned({
  serial: '01', name: 'CN=127.0.0.1',
  notBefore: new Date(Date.now() - 864e5), notAfter: new Date(Date.now() + 365 * 864e5),
  keys: certKeys, alg: certAlg,
  extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: '127.0.0.1' }, { type: 'ip', value: '127.0.0.1' }])],
});
const CERT_PEM = certObj.toString('pem');
const keyB64 = Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', certKeys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n');
const KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${keyB64}\n-----END PRIVATE KEY-----\n`;
const getJSON = (url) => new Promise((res, rej) => { const r = https.get(url, { rejectUnauthorized: false }, (rs) => { let d = ''; rs.on('data', (c) => (d += c)); rs.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }); r.on('error', rej); });

/** 模拟平台服务端：登录 POST 记录 {t,u,p}；d-user 前 2 次强制 401，其余按密码正确性 */
const loginLog = [];
const pwMounted = {};
const loginCount = {};
const server = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, (req, res) => {
  const url = new URL(req.url ?? '/', `https://${HOSTNAME}`);
  const js = (body, headers = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(body); };
  const page = `
<!doctype html><html><body>
<form onsubmit="return false">
  <input placeholder="请输入用户名" type="text" />
  <iframe id="pwbox" srcdoc='<span>loading</span>'></iframe>
  <button type="button">登 录</button>
</form>
<script>
/* 场景由用户名区分（par.open 的 URL 无法带参数） */
const scene = () => document.querySelector('input[type=text]').value;
const iframe = document.getElementById('pwbox');
function mountPw() {
  iframe.srcdoc = '<input type="password" placeholder="密码" />';
  fetch('/api/pw-mounted?u=' + scene());
}
if (scene() === 'a-user') { setTimeout(mountPw, 2500); }
else { mountPw(); }
if (scene() === 'b-user') { setTimeout(() => { const f = iframe.contentDocument.querySelector('input'); if (f) f.value = ''; }, 4000); }
document.querySelector('button').addEventListener('click', () => {
  const u = document.querySelector('input[type=text]').value;
  const f = iframe.contentDocument.querySelector('input[type=password]');
  const p = f ? f.value : '';
  fetch('/api/login', { method: 'POST', body: JSON.stringify({ u, p }) }).then((r) => {
    if (r.ok) {
      document.querySelector('button').remove();
    } else {
      const d = document.createElement('div');
      d.className = 'ant-message-error';
      d.textContent = '账号或密码错误';
      document.body.appendChild(d);
    }
  });
});
</script>
login page</body></html>`;
  if (url.pathname === '/login') { js(page); return; }
  if (url.pathname === '/api/pw-mounted') { const u = url.searchParams.get('u') ?? '?'; pwMounted[u] = Date.now(); res.writeHead(200); res.end('{}'); return; }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let u = '', p = '';
      try { ({ u, p } = JSON.parse(body || '{}')); } catch { /* */ }
      loginCount[u] = (loginCount[u] ?? 0) + 1;
      const idx = loginCount[u];
      const ok = u === 'd-user' ? idx > 2 : (u === 'b-user' && idx === 1 ? false : (u === 'c-user' && idx === 1 ? false : p === 'pw123'));
      loginLog.push({ u, p, t: Date.now(), ok });
      const headers = { 'content-type': 'application/json' };
      if (ok) headers['set-cookie'] = `sid=SID_${Date.now()}; Path=/`;
      res.writeHead(ok ? 200 : 401, headers);
      res.end(ok ? '{"ok":true}' : '{"ok":false}');
    });
    return;
  }
  if (url.pathname === '/__log') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ loginLog, pwMounted })); return; }
  res.writeHead(404); res.end('nf');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(443, '127.0.0.1', resolve); });

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) { for (const s of ['chrome-win64', 'chrome-win']) { const p = path.join(mp, d, s, 'chrome.exe'); if (fs.existsSync(p)) return p; } }
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

const profile = path.join(ROOT, 'tmp', 'ui-fillrhythm');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(), headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--ignore-certificate-errors'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

const waitExamplePage = async () => {
  for (let i = 0; i < 30; i++) {
    const p = [...ctx.pages()].filter((x) => x.url().startsWith('https://127.0.0.1')).pop();
    if (p) return p;
    await sleep(500);
  }
  throw new Error('页签未出现');
};
const createAndOpen = async (scene) => {
  const acc = (await page.evaluate((s) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '127.0.0.1', tabName: s, username: `${s}-user`, password: 'pw123', open: false }), scene)).result.data;
  await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id }), acc.id);
  await sleep(1500);
  return waitExamplePage();
};
const logFor = (u) => getJSON(`https://127.0.0.1:443/__log`).then((l) => l.loginLog.filter((e) => e.u === u));

/* 场景 A：密码 iframe 延迟 2.5s 挂载 */
{
  const tab = await createAndOpen('a');
  await sleep(8000);
  const log = await logFor('a-user');
  const mounted = Object.values((await getJSON('https://127.0.0.1:443/__log')).pwMounted)[0]; // a 场景唯一挂载记录
  const first = log[0];
  check('A1 密码未就绪绝不提交（首 POST 晚于挂载）', Boolean(first && mounted && first.t > mounted), `首POST=${first?.t ?? '-'} 挂载=${mounted ?? '-'} 全表=${JSON.stringify((await getJSON('https://127.0.0.1:443/__log')).pwMounted)}`);
  check('A2 提交时密码完整', first?.p === 'pw123', `p=${JSON.stringify(first?.p)}`);
  check('A3 登录成功且无重复提交', log.length === 1 && log[0].ok === true, `POST数=${log.length}`);
  await tab.close();
}
/* 场景 B：首次被拒 + 页面中途清空密码 → 重填后再次提交成功 */
{
  const tab = await createAndOpen('b');
  await sleep(11000);
  const log = await logFor('b-user');
  const last = log.at(-1);
  check('B1 中途清值后重填再提交成功', last?.ok === true && last?.p === 'pw123', `POST数=${log.length} 末p=${JSON.stringify(last?.p)}`);
  check('B2 重试克制（≤3 次）', log.length <= 3, `POST数=${log.length}`);
  await tab.close();
}
/* 场景 C（确定性）：扩展首击被服务端拒绝（401+错误提示）→ 观察期内用户 trusted 点击
 * （值正确 → 200 成功）→ 扩展的后续自动重试必须被接管信号拦下（POST 总数 == 2） */
{
  const tab = await createAndOpen('c');
  // 等扩展完成首次提交（401）
  for (let i = 0; i < 20; i++) {
    if ((await logFor('c-user')).length >= 1) break;
    await sleep(500);
  }
  await sleep(400); // 错误提示已渲染
  await tab.click('button', { force: true, timeout: 5000 }).then(() => null, (e) => console.log('  [C] click 异常:', String(e).slice(0, 120)));
  await sleep(8000); // 观察期 3.5s + 重试点 + 冗余
  const log = await logFor('c-user');
  check('C1 扩展首击被拒后用户点击成功（用户接管有效）', log.length === 2 && log[0].ok === false && log[1].ok === true, `POST数=${log.length} 结果=[${log.map((e) => e.ok).join(',')}]`);
  check('C2 用户点击后扩展让位（不再追加自动重试）', log.length === 2, `POST数=${log.length}`);
  await tab.close();
}
/* 场景 D：服务端连续拒绝 → 最多一次重填重试后让位 */
{
  const tab = await createAndOpen('d');
  await sleep(12000);
  const log = await logFor('d-user');
  check('D1 失败感知停止（POST ≤ 2）', log.length <= 2, `POST数=${log.length}`);
  await sleep(4000);
  const log2 = (await logFor('d-user')).length;
  check('D2 停止后不再重试', log2 === log.length, `前=${log.length} 后=${log2}`);
  await tab.close();
}

await ctx.close();
server.close();
console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
