import fs from 'node:fs';
const from = process.argv[2];
const to = process.argv[3];
if (!from || !to) throw new Error('用法: node tools/bump.mjs <from> <to>');
const bump = (f, make, expect) => {
  const s = fs.readFileSync(f, 'utf8');
  const target = make(to);
  if (!s.includes(expect)) throw new Error(`${f}: 未找到 ${expect}`);
  fs.writeFileSync(f, s.replace(expect, target));
  console.log(`${f}: ${expect} -> ${target}`);
};
bump('packages/extension/manifest.json', (v) => `"version": "${v}"`, `"version": "${from}"`);
bump('package.json', (v) => `"version": "${v}"`, `"version": "${from}"`);
bump('packages/extension/src/shared/constants.ts', (v) => `EXT_VERSION = '${v}'`, `EXT_VERSION = '${from}'`);
