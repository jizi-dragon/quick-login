/**
 * IDB 全量参数分析器 —— 吃 tmp/research-idb/snap-*.json，产出：
 *   research/idb-permissions/reports/01-idb-parameters.md   （权限控制粒度分析）
 *   tmp/research-idb/params-<snap>.json                     （机器可读参数树）
 * 用法：node research/idb-permissions/analyze-idb.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const DIR = path.join(ROOT, 'tmp', 'research-idb');
const REPORTS = path.join(ROOT, 'research', 'idb-permissions', 'reports');
fs.mkdirSync(REPORTS, { recursive: true });

const PERM_RE = /admin|perm|power|role|menu|page|auth|security|interface|system|user|config|func/i;

/** 解析条目值：外层 {id, values:"<json 字符串>"} → payload 对象 */
function parseEntryValue(raw) {
  try {
    const outer = JSON.parse(raw); // {"id":"...","values":"{\"...\":...}"}
    const values = typeof outer.values === 'string' ? JSON.parse(outer.values) : outer.values;
    return { id: outer.id, payload: values, raw: outer.values };
  } catch {
    return { id: null, payload: null, raw };
  }
}

/** 参数树：深度优先收集 path → {type, preview}，flag = 权限相关 */
function walk(node, prefix, out, depth = 0) {
  if (depth > 4 || node === null || typeof node !== 'object') {
    out.push({ path: prefix, type: typeof node, preview: String(node)?.slice(0, 50), flag: PERM_RE.test(prefix) });
    return out;
  }
  if (Array.isArray(node)) {
    // 数组取首元素代表结构，但记录长度
    out.push({ path: `${prefix}[]`, type: 'array', preview: `len=${node.length}`, flag: PERM_RE.test(prefix) });
    if (node.length) walk(node[0], `${prefix}[0]`, out, depth + 1);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      walk(v, p, out, depth + 1);
    } else {
      out.push({ path: p, type: typeof v, preview: String(v)?.slice(0, 50), flag: PERM_RE.test(p) });
    }
  }
  return out;
}

/** 深比较两个 payload，返回差异路径 */
function deepDiff(a, b, prefix = '', out = [], depth = 0) {
  if (depth > 5) return out;
  if (JSON.stringify(a) === JSON.stringify(b)) return out;
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    out.push({ path: prefix || '(root)', a: JSON.stringify(a)?.slice(0, 60), b: JSON.stringify(b)?.slice(0, 60) });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    deepDiff(a?.[k], b?.[k], prefix ? `${prefix}.${k}` : k, out, depth + 1);
  }
  return out;
}

const snaps = fs.readdirSync(DIR).filter((f) => /^snap-\d+.*\.json$/.test(f)).sort();
if (!snaps.length) {
  console.error('tmp/research-idb/ 下没有 snap-*.json，先让驱动器执行 SNAP');
  process.exit(1);
}

const md = ['# 报告 01 · IndexedDB 全量参数解析（权限控制粒度）', '', `生成时间：${new Date().toLocaleString('zh-CN')}，快照 ${snaps.length} 份`, ''];
const crossIndex = new Map(); // entryId → [{snap, tab, len, sha1, payload}]

for (const f of snaps) {
  const snap = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
  const paramsOut = {};
  md.push(`---`, '', `## 快照 ${f} · T${snap.tab} · ${snap.url.slice(0, 80)}`, '');
  for (const [db, stores] of Object.entries(snap.dbs ?? {})) {
    md.push(`### 库 \`${db}\``, '');
    for (const [store, sInfo] of Object.entries(stores ?? {})) {
      if (sInfo.err) {
        md.push(`- 仓 \`${store}\`：读取失败 ${sInfo.err}`);
        continue;
      }
      md.push(`### 仓 \`${store}\`（${sInfo.count} 条，keyPath=${JSON.stringify(sInfo.keyPath)}）`, '');
      md.push('| 条目 id | len | sha1(前8) | 权限相关参数（path=preview） | 全部参数路径数 |', '|---|---|---|---|---|');
      for (const e of sInfo.entries ?? []) {
        const { id, payload, raw } = parseEntryValue(e.value);
        const len = raw?.length ?? 0;
        const sha1 = crypto.createHash('sha1').update(raw ?? '').digest('hex').slice(0, 8);
        const tree = payload ? walk(payload, '', []) : [{ path: '(未解析)', type: typeof raw, preview: String(raw).slice(0, 40), flag: false }];
        const flagged = tree.filter((t) => t.flag);
        md.push(`| ${id ?? '?'} | ${len} | ${sha1} | ${flagged.slice(0, 12).map((t) => `\`${t.path}\`=${t.preview}`).join('<br>')}${flagged.length > 12 ? `<br>…共${flagged.length}项` : ''} | ${tree.length} |`);
        if (id) {
          if (!crossIndex.has(id)) crossIndex.set(id, []);
          crossIndex.get(id).push({ snap: f, tab: snap.tab, len, sha1, payload });
        }
        paramsOut[`${db}/${store}/${id}`] = { len, sha1, tree };
      }
      md.push('');
    }
  }
  fs.writeFileSync(path.join(DIR, `params-${f.replace('.json', '')}.json`), JSON.stringify(paramsOut, null, 1));
}

md.push(`---`, '', '## 跨账号同键差异（同一 entry id 在不同账号下的参数级 diff）', '');
for (const [id, hits] of crossIndex) {
  const bySha = new Map(hits.map((h) => [h.sha1, h]));
  if (bySha.size < 2) continue;
  md.push(`### 条目 ${id}`, '');
  const list = [...bySha.values()];
  for (const h of list) md.push(`- ${h.sha1} len=${h.len}（${h.snap} T${h.tab}）`);
  for (let i = 1; i < list.length; i++) {
    const diffs = deepDiff(list[0].payload, list[i].payload);
    md.push(`  - diff(${list[0].sha1} → ${list[i].sha1})：${diffs.length} 处`);
    for (const d of diffs.slice(0, 30)) {
      md.push(`    - \`${d.path}\`：${d.a} ⇒ ${d.b}`);
    }
  }
  md.push('');
}

const report = path.join(REPORTS, '01-idb-parameters.md');
fs.writeFileSync(report, md.join('\n'));
console.log(`✔ 报告已生成：${report}`);
console.log(`  条目总数（去重 id）：${crossIndex.size}；跨账号差异条目：${[...crossIndex.values()].filter((h) => new Set(h.map((x) => x.sha1)).size > 1).length}`);
