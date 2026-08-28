/**
 * 事件流随手取证：node tools/e2e/peek.mjs [type1,type2,...] [--tail N] [--full]
 * 不带参数 = 全类型统计；带 type = 展示该类型最新若干条（默认 6 条，--full 不截断）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'tmp', 'e2e-events.jsonl');
const args = process.argv.slice(2);
const tailN = (() => {
  const i = args.indexOf('--tail');
  return i >= 0 ? Number(args[i + 1]) : 6;
})();
const full = args.includes('--full');
const types = args.filter((a) => !a.startsWith('--') && isNaN(Number(a)) && a !== args[args.indexOf('--tail') + 1]);

const lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const byType = new Map();
for (const e of lines) {
  byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
}

if (!types.length) {
  console.log('=== 类型统计 ===');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(5), t);
  }
  process.exit(0);
}

const clip = (v, n) => {
  if (full || v === null || v === undefined) return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

/** 从任意文本里抠出 JWT 并解码载荷 */
function jwtFrom(text) {
  const m = /eyJ[\w-]+\.[\w-]+\.[\w-]*/.exec(text ?? '');
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
/** WIF 声明里最有辨识度的字段串 */
function whoOf(payload) {
  if (!payload) return null;
  const keys = Object.keys(payload);
  const pick = (suffix) => keys.find((k) => k.endsWith(suffix));
  const guid = payload[pick('nameidentifier')];
  const name = payload[pick('name')] ?? payload.username ?? payload.sub ?? payload.uid;
  const role = payload[pick('role')];
  return `${guid ? guid.slice(0, 8) : '?'}|${clip(name, 20)}|role=${clip(role, 30)}`;
}

for (const t of types) {
  const hits = lines.filter((e) => e.type === t).slice(-tailN);
  console.log(`\n=== ${t}（共 ${byType.get(t) ?? 0} 条，显示最后 ${hits.length}）===`);
  for (const e of hits) {
    const time = new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false });
    if (t === 'set-cookie') {
      console.log(`[${time}] T${e.tab} status=${e.status} ${clip(e.url, 100)}`);
      for (const c of e.cookies ?? []) {
        console.log(`   ${c.name} = ${clip(c.value, full ? 99999 : 48)}  [${c.flags?.join(' ') ?? ''}]`);
      }
    } else if (t === 'identity-snap') {
      console.log(`[${time}] T${e.tab} ${clip(e.url, 80)}`);
      const tok = e.probe?.cookieTokenPayload ?? jwtFrom(e.probe?.cookieView);
      if (tok) {
        console.log(`   ▸ cookie中的token主体: ${whoOf(tok)}`);
        if (full) console.log(`   ▸ payload=${JSON.stringify(tok)}`);
      }
      for (const [acct, info] of Object.entries(e.probe?.namespaces ?? {})) {
        const tp = info.tokenPayload ?? {};
        console.log(`   账号 ${acct.slice(0, 14)}… 主体=${whoOf(tp)}`);
        console.log(`     fp=${clip(info.deviceFp, 40)}`);
      }
      console.log(`   cookie视图=${clip(e.probe?.cookieView, full ? 99999 : 120)}`);
      if (e.probe?.fpValues?.length > 1) console.log(`   ⚠ 多指纹并存: ${e.probe.fpValues.length}`);
      const idb = e.probe?.idb ?? {};
      for (const [db, stores] of Object.entries(idb)) {
        if (stores.err) {
          console.log(`   IDB[${db}] 错误: ${stores.err}`);
          continue;
        }
        for (const [s, info] of Object.entries(stores)) {
          console.log(`   IDB[${db}].${s} 共${info.count}条`);
          for (const e2 of info.sample ?? []) {
            if (e2?.sha1 !== undefined) {
              console.log(`     ${e2.id}… len=${e2.len} sha1=${e2.sha1} ${e2.admin ?? ''} | ${clip(e2.head, 60)}`);
            } else {
              console.log(`     ${clip(e2, 200)}`);
            }
          }
        }
      }
    } else if (t === 'wire-auth') {
      const p = typeof e.authSubject === 'object' ? e.authSubject : jwtFrom(e.authSubject);
      console.log(`[${time}] T${e.tab} ${p ? whoOf(p) : clip(e.authSubject, 70)}  ← ${clip(e.url, 90)}`);
    } else if (t === 'raw-storage') {
      console.log(`[${time}] ${clip(JSON.stringify(e).slice(0, 400), 400)}`);
    } else {
      console.log(`[${time}] ${clip(JSON.stringify(e), full ? 99999 : 260)}`);
    }
  }
}
