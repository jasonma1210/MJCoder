// 第八轮 D-804：MCP 代际路线的**一致性门禁**（判据 10.6「声称与守护一一对应」）
//
// 要防的是什么：
//   MCP `2026-07-28` 是一次断裂式升级（移除 initialize 握手与 Mcp-Session-Id，改无状态
//   请求/响应）。本客户端建在有状态握手上，**不能靠改常量声称支持**。
//   最坏的形态不是「不支持」，而是「支持集里写了 2026-07-28，实际连不上」——
//   外部看到的是版本能力声明，内部却是死路径，属于典型的「声称但无守护」。
//
// 本套件把「声称」变成机器可查的状态，并做**双向**断言：
//   ① `nextStatus === 'not-implemented'` ⇒ 支持集**不得**包含 next 版本（防虚报）；
//   ② `nextStatus === 'implemented'`     ⇒ 支持集**必须**包含 next 版本（防改了状态忘了接线）；
//   ③ `PROTOCOL_VERSION` 必须是支持集里最新的一版（防「提议的版本比声称支持的还旧」）；
//   ④ 弃用能力清单必须非空且 ⊆ 当前声明能力（防清单写成空集变成空过）；
//   ⑤ 到期日必须可解析且晚于今天（防写成过去日期后无人复核）。
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_ROADMAP,
  CLIENT_CAPABILITIES,
} from '../main/mcpProtocol.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const road = MCP_PROTOCOL_ROADMAP;

// ── ① / ② 状态与支持集必须一致（双向）──
check('roadmap 结构完整（current / next / nextStatus / dueBy / strategy）',
  !!road.current && !!road.next && !!road.nextStatus && !!road.dueBy && !!road.strategy,
  JSON.stringify({ next: road.next, status: road.nextStatus, dueBy: road.dueBy }));

const claimsNext = SUPPORTED_PROTOCOL_VERSIONS.includes(road.next);
if (road.nextStatus === 'not-implemented') {
  check('① nextStatus=not-implemented ⇒ 支持集不含 next（不得虚报协议代际）',
    claimsNext === false, `支持集=${SUPPORTED_PROTOCOL_VERSIONS.join('/')}；next=${road.next}`);
} else {
  check('② nextStatus=implemented ⇒ 支持集必须含 next（改了状态就得真接线）',
    claimsNext === true, `支持集=${SUPPORTED_PROTOCOL_VERSIONS.join('/')}；next=${road.next}`);
}

// 状态值只能是这两种之一（防笔误让上面两条都不触发 → 空过）
check('nextStatus 取值合法（not-implemented | implemented）',
  ['not-implemented', 'implemented'].includes(road.nextStatus), road.nextStatus);

// ── ③ PROTOCOL_VERSION 必须是支持集里最新的一版 ──
// 会话前缀「最新」按字典序即可（协议版本是 YYYY-MM-DD，字典序 = 时间序）。
const newestSupported = [...SUPPORTED_PROTOCOL_VERSIONS].sort().slice(-1)[0];
check('③ PROTOCOL_VERSION = 支持集中最新的一版（不提议比自己声称支持的更旧的版本）',
  PROTOCOL_VERSION === newestSupported,
  `proposed=${PROTOCOL_VERSION} newestSupported=${newestSupported}`);

// ── ④ 弃用能力清单：非空、且确实是当前声明过的能力 ──
check('④ deprecatedInNext 非空（空清单等于没约束）',
  Array.isArray(road.deprecatedInNext) && road.deprecatedInNext.length > 0,
  JSON.stringify(road.deprecatedInNext));
check('④ deprecatedInNext ⊆ 当前 CLIENT_CAPABILITIES（弃用的必须是真声明过的）',
  road.deprecatedInNext.every((c) => Object.prototype.hasOwnProperty.call(CLIENT_CAPABILITIES, c)),
  `caps=${Object.keys(CLIENT_CAPABILITIES).join('/')}`);

// ── ⑤ 到期日可解析且在未来 ──
const due = Date.parse(road.dueBy);
check('⑤ dueBy 可解析为合法日期', Number.isFinite(due), road.dueBy);
check('⑤ dueBy 尚未到期（已过期则必须重新排期，不能静默继续拖延）',
  Number.isFinite(due) && due > Date.now(), `${road.dueBy} vs 今天 ${new Date().toISOString().slice(0, 10)}`);

// ── 迁移形态必须是双栈协商（硬切会打断大量仍在旧版的服务端）──
check('迁移策略 = dual-stack-negotiation（不硬切）',
  road.strategy === 'dual-stack-negotiation', road.strategy);
check('roadmap 指向可查的决策记录（不是无锚点的口头排期）',
  typeof road.trackedIn === 'string' && /\.md/.test(road.trackedIn), road.trackedIn);

console.log(`\nmcp-protocol-roadmap: ${pass}/${pass + fail} 通过`);
if (fail > 0) process.exitCode = 1;
