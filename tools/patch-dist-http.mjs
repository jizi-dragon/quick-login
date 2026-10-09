/** C-pre: patch dist/background.js 的 https:// 模板字面量为 http://（体验用临时补丁） */
import fs from 'node:fs';
const f = 'dist/background.js';
let c = fs.readFileSync(f, 'utf8');
const pat = /https:\/\/\$\{/g;
const n = (c.match(pat) || []).length;
c = c.replace(pat, 'http://${');
fs.writeFileSync(f, c);
const rest = (fs.readFileSync(f, 'utf8').match(pat) || []).length;
console.log(`patched ${n} 处, 剩余 ${rest}`);
