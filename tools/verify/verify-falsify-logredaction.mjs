/**
 * 反证：证明 `log-redaction.mjs` 真的会红。
 *
 * 依据 quick-login AGENTS.md 规则 17 与 akso-vault PITFALLS #21：
 * **写完判据先问"拆掉什么它才会红？"** 答不上来说明它没在验任何东西。
 *
 * 做法：临时把打码改成"直接返回原文"，跑验收并断言**必须失败**，
 *       最后无论成败都把文件逐字节还原（放 `finally`）。
 *
 * 跑法：node tools/verify/verify-falsify-logredaction.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // tools/verify/ → 仓库根（两层）
const LOG_TS = join(ROOT, 'packages', 'extension', 'src', 'shared', 'log.ts');
const CHECK = join(HERE, 'verify-log-redaction.mjs');

const CASES = [
  {
    label: '① 打码被绕过（formatArgs 直接返回原文）⇒ 凭据原样输出',
    anchor: '  return redact(text);',
    broken: '  return text;  // 缺陷版：不调用 redact',
    expectRed: true,
  },
  {
    label: '② 只打码第一个参数（漏掉分隔参数）⇒ password=%s 形态失效',
    anchor: "  const text = typeof first === 'string' ? interpolate(first, rest) : args.map(stringify).join(' ');",
    broken: "  const text = typeof first === 'string' ? first : args.map(stringify).join(' ');",
    expectRed: true,
  },
];

function runCheck() {
  try {
    execFileSync(process.execPath, [CHECK], { stdio: 'pipe', encoding: 'utf8' });
    return false; // 退出码 0 = 没红
  } catch {
    return true; // 非 0 = 红了
  }
}

const failures = [];

// 基线：未改动时必须通过
console.log('=== 基线（未改动）：验收必须通过 ===');
const baselineGreen = !runCheck();
console.log(`  ${baselineGreen ? 'OK  ' : 'FAIL'} 基线${baselineGreen ? '通过' : '不通过 —— 先修验收本身'}`);
if (!baselineGreen) failures.push('基线就不通过');

for (const c of CASES) {
  const original = readFileSync(LOG_TS, 'utf8');
  if (!original.includes(c.anchor)) {
    console.log(`\n=== ${c.label} ===\n  SKIP 锚点没找到（源码变了？）`);
    failures.push(`${c.label}：锚点没找到`);
    continue;
  }
  try {
    writeFileSync(LOG_TS, original.replace(c.anchor, c.broken), 'utf8');
    console.log(`\n=== ${c.label} ===`);
    const red = runCheck();
    if (red) {
      console.log('  OK   如期变红 —— 反证有效');
    } else {
      console.log('  FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！');
      failures.push(`${c.label}：缺陷版下仍绿`);
    }
  } finally {
    // ★ 写回时用 utf8 且内容与原文完全一致 —— 逐字节还原
    writeFileSync(LOG_TS, original, 'utf8');
    const same = readFileSync(LOG_TS, 'utf8') === original;
    if (!same) failures.push(`${c.label}：还原失败`);
  }
}

console.log('\n=== 还原核对 ===');
console.log(`  ${readFileSync(LOG_TS, 'utf8').includes('return redact(text);') ? 'OK  ' : 'FAIL'} log.ts 已还原（含 redact 调用）`);

const total = CASES.length + 1;
const passed = total - failures.length;
console.log(`\nRESULT: ${passed}/${total} ${failures.length ? '—— 失败：' + failures.join('; ') : '反证通过（验收有效且已还原）'}`);
process.exit(failures.length ? 1 : 0);
