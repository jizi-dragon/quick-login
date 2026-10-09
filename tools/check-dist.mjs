import fs from 'node:fs';
const s = fs.readFileSync('dist/ui/parallel/parallel.js', 'utf8');
console.log('dist parallel.js 含 ql:defaultBox:', s.includes('ql:defaultBox'));
console.log('dist parallel.js 含 修改默认盒子名称:', s.includes('修改默认盒子名称'));
console.log('dist parallel.js 含 我的主场无关/默认盒title:', s.includes('未归盒账号的归宿'));
console.log('dist manifest version:', JSON.parse(fs.readFileSync('dist/manifest.json', 'utf8')).version);
console.log('dist background.js 含 defaultBox 处理(无需):', fs.readFileSync('dist/background.js', 'utf8').includes('defaultBox'));
