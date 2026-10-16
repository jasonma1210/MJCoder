// T3-2 工具：单模块语言包自检（抽取组用，避免等全量门禁）。
// 用法：node scripts/i18n-modcheck.mjs <module>...
// 断言：zh-CN/<m>.json 与 en-US/<m>.json 都存在、可解析、深度 key 集一致、
//       叶子都是字符串、同 key 的 {var} 插值参数集一致。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCALES = path.join(DESKTOP, 'renderer', 'src', 'i18n', 'locales');
const mods = process.argv.slice(2);
if (!mods.length) { console.error('用法：node scripts/i18n-modcheck.mjs <module>...'); process.exit(2); }

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => {
  const kp = p ? `${p}.${k}` : k;
  if (v && typeof v === 'object' && !Array.isArray(v)) return flat(v, kp);
  return [[kp, v]];
});

let bad = 0;
for (const m of mods) {
  const problems = [];
  let zh, en;
  try { zh = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN', `${m}.json`), 'utf8')); }
  catch (e) { problems.push(`zh-CN/${m}.json 读取失败：${e.message}`); }
  try { en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en-US', `${m}.json`), 'utf8')); }
  catch (e) { problems.push(`en-US/${m}.json 读取失败：${e.message}`); }
  if (!problems.length) {
    const zk = flat(zh), ek = new Map(flat(en));
    for (const [k, v] of zk) {
      if (!ek.has(k)) { problems.push(`en 缺 key：${k}`); continue; }
      if (typeof v !== 'string') problems.push(`zh 叶子非字符串：${k}`);
      if (typeof ek.get(k) !== 'string') problems.push(`en 叶子非字符串：${k}`);
      const vars = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(',');
      if (vars(v) !== vars(ek.get(k))) problems.push(`{var} 不一致：${k} zh{${vars(v)}} en{${vars(ek.get(k))}}`);
    }
    for (const [k] of ek) if (!zk.some(([zk2]) => zk2 === k)) problems.push(`en 多余 key：${k}`);
  }
  if (problems.length) {
    console.error(`[FAIL] ${m}:\n  ${problems.slice(0, 30).join('\n  ')}`);
    bad++;
  } else console.log(`[OK] ${m}`);
}
process.exit(bad ? 1 : 0);
