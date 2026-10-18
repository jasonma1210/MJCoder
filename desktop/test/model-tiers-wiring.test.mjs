#!/usr/bin/env node
// P1-11c 任务-模型分档的接线门禁
//
// 缺陷形态（又一个「每环都有代码、中间缺一次注入」）：
//   ① agent-core 早已能读 `modelOverrides`（compact/decompose 槽位）；
//   ② workerPool 早已检查 `deps.getModelOverrides`；
//   ③ 渲染层 `getModelOverrides/setModelOverrides` 早已存在；
//   但 **设置页没有入口**、**渲染层从不同步主进程**（主进程读不到 localStorage）、
//   **main.js 从未注入 getModelOverrides** ⇒ 三槽位全部永远回落主模型，且没有任何报错。
//
// 本套件锁整条链：设置页入口 → localStorage → preferences 同步 → 主进程注入 → workerPool 消费。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const DESKTOP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => fs.readFileSync(path.join(DESKTOP, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

const settings = read('renderer/src/components/SettingsModal.jsx');
const modelCfg = read('renderer/src/lib/modelConfig.js');
const mainSrc = read('main/main.js');
const workerPool = read('main/workerPool.js');
const zh = readJson('renderer/src/i18n/locales/zh-CN/settings.json');
const en = readJson('renderer/src/i18n/locales/en-US/settings.json');

// ── ① 设置页入口 ───────────────────────────────
check('设置页渲染三槽位（遍历 OVERRIDE_SLOTS，不硬编码）',
  /OVERRIDE_SLOTS\.map\(/.test(settings));
check('设置页有「跟随主模型」的空选项（留空 = 不传字段，零破坏）',
  /settings\.modelTierFollow/.test(settings));
check('修改槽位时调用 setModelOverrides（渲染层内即时生效）',
  /setModelOverrides\(next\)/.test(settings));

// ── ② 同步到主进程（主进程读不到 localStorage，这是最容易漏的一环）──
check('设置页把 model_overrides 同步到主进程偏好',
  /localSetPreference\?\.\(\{\s*key:\s*'model_overrides'/.test(settings),
  '缺这一环 ⇒ Worker 分档永远不生效（且无报错）');

// ── ③ 主进程注入 + 消费 ─────────────────────────
check('main.js 向 workerPool 注入 getModelOverrides',
  /getModelOverrides:\s*\(\)\s*=>\s*localStore\?\.getPreference\('model_overrides'\)/.test(mainSrc));
check('workerPool 真的读 deps.getModelOverrides',
  /deps\.getModelOverrides\s*\(\)/.test(workerPool));
check('worker 槽位缺 providerId 时回落主模型（配置错误不拖垮整组任务）',
  /缺少 providerId/.test(workerPool));

// ── ④ 渲染层存储契约仍一致 ──────────────────────
check('OVERRIDE_SLOTS 为 compact/decompose/worker 三槽',
  /OVERRIDE_SLOTS\s*=\s*\['compact',\s*'decompose',\s*'worker'\]/.test(modelCfg));
check('setModelOverrides 仍落 localStorage（压缩/拆解路径直接读它）',
  /localStorage\.setItem\(OVERRIDES_KEY/.test(modelCfg));

// ── ⑤ i18n 双语齐备 ────────────────────────────
const KEYS = [
  'modelTiers', 'modelTiersDesc',
  'modelTier_compact', 'modelTier_decompose', 'modelTier_worker', 'modelTierFollow',
];
const missingZh = KEYS.filter((k) => !(typeof zh[k] === 'string' && zh[k].length > 0));
const missingEn = KEYS.filter((k) => !(typeof en[k] === 'string' && en[k].length > 0));
check('zh-CN 六个 key 齐备', missingZh.length === 0, missingZh.join(',') || '全有');
check('en-US 六个 key 齐备', missingEn.length === 0, missingEn.join(',') || '全有');

console.log(`\nmodel-tiers-wiring: ${pass}/${pass + fail} 通过`);
if (fail) process.exitCode = 1;
