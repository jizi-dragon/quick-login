/**
 * `AGENTS.md` 的**指令预算**与**与 `docs/RULES.md` 的同步**。
 *
 *     node tools/verify/verify-agents-budget.mjs
 *
 * ## 为什么这条值得存在（实测 2026-10-09）
 *
 * `AGENTS.md` 一度到 **66379 B**，而 agent 的**工作区指令预算约 65536 B**
 * ⇒ 载入时**被截断**，**最后的规则（39）读不全**。
 * ★ 那一刻它不是"文档有点长"，而是 **"规则 39 事实上不存在"** —— 而**没有任何门禁会说话**：
 *   markdown 没有大小限制、`typecheck` 不管文档、`verify-*` 全绿。
 *
 * ★ 而根因是本仓**自己写在头部的规矩**：
 *   「**本文件只放「祈使句 + 判据 + 出处指针」，不复述事故经过。**」——
 *   39 条规则行合计 **45802 B（占全文 69%）**，每条都抄了长段 `实测` 叙事。
 * ⇒ 处置：正文移到 `docs/RULES.md`（**逐字搬移**），`AGENTS.md` 只留**索引 + 指针**。
 *   实测 **66379 → 24021 B**，而**规则正文一个字都没丢**（与备份逐字对照通过）。
 *
 * ## 判据
 *
 * ① `AGENTS.md` **必须小于安全预算**（留出余量给别的指令文件，如 `CLAUDE.md`）；
 * ② `AGENTS.md` 的规则索引与 `docs/RULES.md` 的正文**编号集合一致**（不许一边漏）；
 * ③ 两个文件**互相有指针**（否则读了索引的人不知道怎么读正文，反之亦然）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AG = path.join(ROOT, 'AGENTS.md');
const RULES = path.join(ROOT, 'docs', 'RULES.md');

/** ★ 安全预算：实测 agent 的工作区指令预算是 **65536 B**，
 *  而它是**所有**指令文件合计。`AGENTS.md` 是最大的一份，
 *  所以给它一个明显更小的上限，留出余量（`CLAUDE.md` / 上层 `AGENTS.md` 等）。 */
const BUDGET = 48 * 1024;

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('=== 前提 ===');
check('AGENTS.md 存在', existsSync(AG));
check('docs/RULES.md 存在', existsSync(RULES),
  existsSync(RULES) ? '' : '★ 规则正文没有独立文件 ⇒ ① 的拆分被回退了');
if (!existsSync(AG) || !existsSync(RULES)) process.exit(1);

const ag = readFileSync(AG, 'utf8');
const rules = readFileSync(RULES, 'utf8');

// ---------------------------------------------------------------- ① 体积
console.log('\n=== ① AGENTS.md 在指令预算内 ===');
const size = statSync(AG).size;
check(`AGENTS.md < ${BUDGET / 1024} KB`, size < BUDGET,
  `实测 ${(size / 1024).toFixed(1)} KB`
  + (size < BUDGET ? '' : ' ★ 超出 ⇒ 载入时会被截断，最后的规则读不全'));

// ---------------------------------------------------------------- ② 编号集合一致
console.log('\n=== ② 索引与正文的编号集合一致 ===');
const numsOf = (t) => [...t.matchAll(/^\| (\d+) \|/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
const agNums = numsOf(ag);
const ruleNums = numsOf(rules);
check('前提：两边的编号集合都非空', agNums.length > 0 && ruleNums.length > 0,
  `索引 ${agNums.length} / 正文 ${ruleNums.length}`);
const missingInRules = agNums.filter((n) => !ruleNums.includes(n));
const missingInAg = ruleNums.filter((n) => !agNums.includes(n));
check('索引里每条在正文里都有', missingInRules.length === 0,
  missingInRules.length ? `★ 缺 ${missingInRules.join(',')}` : `${agNums.length} 条`);
check('正文里每条在索引里都有', missingInAg.length === 0,
  missingInAg.length ? `★ 缺 ${missingInAg.join(',')}` : `${ruleNums.length} 条`);
check('两边的编号都连续（1..N 无缺号）',
  agNums.join(',') === ruleNums.join(',') && agNums.every((n, i) => n === i + 1),
  `1..${Math.max(...agNums, ...ruleNums)}`);

// ---------------------------------------------------------------- ③ 互相有指针
console.log('\n=== ③ 两个文件互相有指针 ===');
check('AGENTS.md 指向 docs/RULES.md', /docs\/RULES\.md/.test(ag));
// ★ 头部**那一张表**里必须有 RULES.md —— 新人第一眼看的就是它。
//   ★ 我第一版写得不对：`ag.split('---')[0]` 会被 markdown 表格的**分隔行**
//     （`|---|---|`）抢先切开 ⇒ 取到的段落比预期短得多 ⇒ **假红**。
//   ⇒ 改成按**行**找"头部的表格行"（以 `> |` 开头），范围就是那张表本身。
const headerTable = ag.split('\n').filter((l) => l.startsWith('> |')).join('\n');
check('AGENTS.md 头部索引表里列出 RULES.md', /RULES\.md/.test(headerTable),
  `头部表 ${headerTable.split('\n').length} 行`);
check('docs/RULES.md 指回 ../AGENTS.md', /\.\.\/AGENTS\.md/.test(rules));
check('docs/RULES.md 指向 docs/PITFALLS.md', /PITFALLS\.md/.test(rules));

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
