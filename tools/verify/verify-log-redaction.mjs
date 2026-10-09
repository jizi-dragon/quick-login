/**
 * 验收：日志打码通道（`src/shared/redact.ts` + `src/shared/log.ts`）。
 *
 * 两侧都要验：
 *   · **漏**（false negative）⇒ 凭据真的进了 DevTools / 诊断缓冲，最严重的失败；
 *   · **过度**（false positive）⇒ 正常信息被打掉，日志失去价值，
 *     于是有人会去把打码关掉 —— 那是**下一条**泄露路径。
 *
 * ★ 这个脚本**必须能红**。改完打码规则后如果它仍然全绿，先怀疑它没在验东西。
 *
 * 跑法：node tools/verify/verify-log-redaction.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 仓库根：tools/verify/ 往上两层。少一层会静默指向 tools/（AGENTS.md 规则 15）
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');

// 直接把 TS 源当文本读进来太脆（要剥类型）。改用 esbuild 现场转译，
// 它与真实构建用同一个编译器 ⇒ 验的就是将要发布的那份代码。
//
// ★ 用 iife + globalName 而不是 format:'esm'：esm 产物导出来时拿不到命名导出
//   （实测 `redact is not a function`）。iife 把导出挂到一个名字上，
//   再用 `new Function` 求值取回来 —— 不依赖 Node 的模块解析，也就不用引 `vm`。
const esbuild = await import('esbuild');
const REDACT_TS = join(SRC, 'shared', 'redact.ts');
const LOG_TS = join(SRC, 'shared', 'log.ts');

const bundle = await esbuild.build({
  entryPoints: [LOG_TS],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__qlLog',
  target: 'chrome110',
  platform: 'browser',
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;
const mod = new Function(`${code}\nreturn __qlLog;`)();
const { redact, REDACTED, formatArgs, getLogger, setLogLevel, drain, clearBuffer } = mod;
void formatArgs; // 目前只用它做内部拼接，保留解构以便后续加用例

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- ① 必须打掉
console.log('\n=== 1. 必须被打掉的（漏了就是凭据外泄）===');
const SECRETS = [
  ['等号赋值', 'password=Liyulong0901', 'Liyulong0901'],
  ['冒号赋值', 'token: abcdef1234567890', 'abcdef1234567890'],
  ['大写键名', 'PASSWORD=hunter2xyz', 'hunter2xyz'],
  ['连字符键名', 'api-key=sk-abcdefghijklmn', 'sk-abcdefghijklmn'],
  ['下划线键名', 'private_key=secretvalue', 'secretvalue'],
  // ★ 下面几条是实测踩过的边界，都曾经**完全绕过**打码
  ['JSON 键名带引号', '"secret": "s3cr3t-value-here"', 's3cr3t-value-here'],
  ['整个 JSON 对象', '{"password": "p@ss", "token": "t0k3n9x"}', 'p@ss'],
  ['JSON 第二个键', '{"password": "p@ss", "token": "t0k3n9x"}', 't0k3n9x'],
  ['单引号包键名', "secret='x'", 'x'],
  ['Bearer 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbGciOiJIUzI1NiJ9'],
  ['Basic 头', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
  ['设备流 device_code', 'GET /device-token?device_code=9f8e7d6c5b4a', '9f8e7d6c5b4a'],
  ['设备流 user_code', 'GET /approve?user_code=WXYZ-1234', 'WXYZ-1234'],
  ['Fernet 密钥', 'fernetKey = dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA==',
    'dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA=='],
  ['裸长十六进制', 'hash 8f14e45fceea167a5a36dedd4bea2543 end',
    '8f14e45fceea167a5a36dedd4bea2543'],
  ['平台的 encKey', 'encKey: 3c9909afec25354d551dae21590bb26e', '3c9909afec25354d551dae21590bb26e'],
];
for (const [label, sample, secret] of SECRETS) {
  const out = redact(sample);
  check(`${label}: ${sample.slice(0, 46)}`, !out.includes(secret), `-> ${out.slice(0, 58)}`);
}

// ★ 单字符凭据要**单独**断言：不能查"这个字符在不在结果里" ——
//   占位符 `«已打码»` **本身就含 `a`**（"打码"的拼音），
//   于是 `!out.includes('a')` 会因占位符而失败，看起来像漏打码，其实是打码成功了。
{
  const out = redact('password="a"');
  check('单字符短口令（单独断言，避开占位符里的 a）',
    out === `password="${REDACTED}"`, `-> ${out}`);
}

// ---------------------------------------------------------------- ② 不该打掉
console.log('\n=== 2. 不该被打掉的（过度匹配会让日志失去价值）===');
const KEEP = [
  'user@example.com',
  '115.231.78.4:44791',
  'GET /api/vault/snapshot HTTP/1.1 200 OK',
  'ql:auto-login',
  '账号 42 个，站点 7 个',
  '9f2c1b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
  '2026-10-09 13:08:19.123',
  'status=active',
  'tabId=12345 frameId=0',
];
for (const sample of KEEP) {
  const out = redact(sample);
  check(`${sample.slice(0, 46)}`, out === sample, out === sample ? '' : `-> ${out}`);
}

// ---------------------------------------------------------------- ③ 幂等
console.log('\n=== 3. 幂等（Formatter / sink 可能被复用多层）===');
{
  const once = redact('password=abc12345');
  check('打两次与打一次相同', redact(once) === once, `${once} -> ${redact(once)}`);
}

// ---------------------------------------------------------------- ④ log() 端到端
console.log('\n=== 4. log() 的端到端（对象序列化 + 打码）===');
{
  clearBuffer();
  setLogLevel('debug');
  const captured = [];
  const realConsole = { ...console };
  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = (...a) => captured.push(a.join(' '));

  const lg = getLogger('test');
  lg.info('password=%s', 'Liyulong0901');
  lg.warn('token=abcdef1234567890');
  // ★ 对象直传 —— 这正是"今天只有计数、明天塞进口令"的那个形态
  lg.error('submit rejected', { username: 'alice', password: 'sup3rs3cret', attempts: 3 });
  lg.debug('正常信息：user@example.com tabId=42');

  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = realConsole[m];

  const joined = captured.join('\n');
  check('log() 里的分隔参数口令被打掉', !joined.includes('Liyulong0901'));
  check('log() 里的 token 被打掉', !joined.includes('abcdef1234567890'));
  check('★ 对象里的 password 被打掉（对象直传路径）', !joined.includes('sup3rs3cret'));
  check('对象的其它字段仍可读（没被整个吞掉）', joined.includes('alice') && joined.includes('attempts'));
  check('正常信息保留', joined.includes('user@example.com') && joined.includes('tabId=42'));
  check('命名空间前缀存在', joined.includes('ql:test'));

  const buf = drain();
  check('环形缓冲里也没有凭据', !JSON.stringify(buf).includes('sup3rs3cret'));
  check('环形缓冲真的收到了记录', buf.length >= 4, `${buf.length} 条`);
  check('缓冲里的 msg 已打码', buf.every((r) => !r.msg.includes('Liyulong0901')));
}

// ---------------------------------------------------------------- ⑤ 结构化：绕不过去
console.log('\n=== 5. 结构：除 log.ts 外不许直接调 console ===');
{
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      if (full === LOG_TS) continue;                       // 唯一允许的地方
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        // 只看**代码**：跳过整行注释
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug)\b/.test(line)) {
          offenders.push(`${full.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
  };
  walk(SRC);
  check(
    '源码里零裸 console.*（log.ts 除外）',
    offenders.length === 0,
    offenders.length ? `命中 ${offenders.length} 处：${offenders.join(', ')}` : '',
  );
}

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
