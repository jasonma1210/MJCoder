# MJCode Agent Harness 第三轮全量审查报告（2026-10-18）

> 范围：`e2c6c05..43aabfe`（含本轮修复提交）
> 方法：四路只读审查并行（引擎层 / 主进程 / 渲染层 / 测试门禁）+ 主理人逐条自证
> 判据：**只有我自己跑出证据的，才写进「已确认」**；审查员给出的结论一律先复核再采纳

---

## 0. 一句话结论

本轮共修复 **8 项**，其中 **2 项是本分支上一轮我自己引入的退化**（可选字段校验把整轮对话打死、
MCP 缓存摘除漏关传输导致掉线）；**1 项是存量 P1**（窗口口径存在两份真值，压缩器会把刚读过的
文件内容抹掉）；其余 5 项为 P2。

审查过程中有 **4 条候选缺陷经复核不成立**，已在 §4 逐条记录 —— 这一节比 §3 更重要，
因为它决定了「下一轮还要不要花时间在同一个地方」。

---

## 1. 基线锚定（本报告所有数字的唯一口径）

| 项 | 值 | 取法 |
|---|---|---|
| commit | `43aabfe` | `git log --oneline -1` |
| 测试套件 | **170 / 170 通过** | `cd desktop && npm test` |
| 未执行（不代表已验证） | 2 | sandbox / sandbox-crossplatform（非 Linux，本机 darwin） |
| typecheck | 0 error | `npm run typecheck` |
| eslint | 0 error / 155 warning | `npm run lint` |
| `main/mcpClient.js` raw 行数 | **800**（软档 800，已写满） | `fs.readFileSync().split('\n').length` |

> ⚠️ 行数口径：`test/max-lines.test.js` 用 **raw** 行（`split('\n').length`），
> eslint 的 `max-lines` 用 **code** 行（skipBlankLines/skipComments）。两者不是一回事，
> 引用行数时必须写清是哪一个。

---

## 2. 元核验：上一条汇报里三组陈述的判定

用户明确要求「这也要确认是否正确」。逐条给结论，**不含糊**。

### 2.1 三件「未做」

| 陈述 | 判定 | 本轮证据 |
|---|---|---|
| 定时任务通道没有 V 层入口 | ✅ **成立** | `createVerificationRun` 全仓只有 2 个调用点（`main/agentRunner.js` / `main/workerPool.js`），定时通道不在其中 |
| J3（独立 verifier turn）默认不接线 | ✅ **成立** | `main/agentRunner.js` 未注入 `l3Chat`；`main/verifyRun.js` 的 `l3Chat` 默认 `null`，走降级分支 |
| UI 换壳未全量（8/9） | ⚠️ **沿用上轮判定，本轮未重新逐处清点** | 本轮未新增证据。按纪律：不带证据的陈述不写成「已确认」 |

### 2.2 三条提醒

| 陈述 | 判定 | 本轮证据 |
|---|---|---|
| `crashed` 态只有手动重连能恢复 | ✅ **成立** | 只有 `mcp:reconnect` 一条通道会重建连接 |
| `settings-coverage` 里有 2 条**函数体长度**断言（非行为断言） | ✅ **成立** | 该套件存在按函数体切片长度断言的用例 |
| 本机无 jsdom / testing-library | ✅ **成立** | `desktop/package.json` 两个都没有 |

> 口径修正：第三条只证明「没有 jsdom」。若用 Playwright/Puppeteer 等**外部**浏览器注入 DOM，
> 「无 jsdom」这个前提仍然为真，但「渲染层不能被自动化测试」的推论**不成立** ——
> 那是另一件事，别混用。

### 2.3 三个坑

| 坑 | 判定 |
|---|---|
| `.then((m) => { x = m; })` 不 `return` → `await` 得到 `undefined`，L3 永远走降级分支 | ✅ 修复结果已在（`.then((m) => { ...; return m; })`） |
| `runVerification` 漏传 `lastTestOutput` → `ReferenceError` | ✅ 修复结果已在（签名加参数 + 调用点传入） |
| 返回对象漏 `reason` 字段 | ✅ 修复结果已在（返回体含 `reason`） |

**但这三条的「过程」不可反推**：我只能验证「现在的代码是对的」，
无法证明当时确实是这三处让它变红的。**结论：结果成立，因果链不成立**（诚实标注，不当成已证事实）。

### 2.4 一处**曾被写错**的陈述

上一条汇报里「P2-5：29 种 padding / 6 档圆角」是**错的**。实测为 **59 种 padding / 8 档圆角**
（早前那个数是子集口径，未声明口径就写成了全集）。工程结论（"圆角与非整数 padding 缺语义 token"）
不变，但数字已更正 —— 这正是「精确性不产生可信度，**可复现性**才产生」的实例。

---

## 3. 本轮新修（8 项，全部有本人实测证据）

### P1-A 契约把「可选字段写错」升级成「整轮对话起不来」〔**本分支新引入的退化**〕

- 形态：上一轮把 `verification` 从「passthrough 透传」改成显式 `z.enum` 登记后，
  `verification: null` 与 `verification.level: 'l9'` 都**被 IPC 契约拒绝**；
  而 `main/agentRunner.js` 对契约失败是 fail-closed（直接 `return { ok:false }`）——
  于是一个**可选**的判定档位字段写错，代价是用户连消息都发不出去。
  改动前它只会被 `verifyRun` 的 `includes()` 归一成 `off`。
- 证据（实测，非静态判断）：
  ```
  verification:null    => REJECT: verification: Invalid input: expected object, received null
  level:l9             => REJECT: verification.level: Invalid option: expected one of "off"|"l1"|"l3"
  ```
- 修复：`shared-ipc/contract.mjs` 改为 `.catch()` 回落产品默认档（`l1`/`annotate`）+ `.nullable()`；
  `skillDisclosure` 同型一并修（`.catch('auto')`）。**保留** enum 的「字段名/取值防漂移」价值。
- 复测：`null` → 放行并视同未指定；`l9` → 回落 `l1`；`l3 + 额外字段` → 保持 `l3` 且额外字段透传。

### P1-B MCP 缓存条目：漏关传输 + 按名字无条件摘除〔**本分支新引入的退化**〕

- 形态三条同源：
  1. 握手等待超时分支只 `servers.delete(name)`，不关旧传输 → stdio 子进程成孤儿（占内存/端口）；
  2. 旧子进程的 `close`/`error` 回调只认 `name` 就 `delete` → 同名重连后**把新连接一起摘掉**
     （用户侧「刚显示已连接就掉线、工具全失效」，日志里看不到任何崩溃）；
  3. 旧回调还会 `onStatus(name,'crashed')` → **新连接状态被旧进程的死亡覆盖成故障**。
- 修复：`main/mcpClient.js` 新增 `detachFrom`（纯核，可在纯 Node 下测身份语义）、
  `detachServer`（按身份摘除）、`retireCached`（先关传输再摘除）；
  超时分支改走 `retireCached`；两个回调都加「已被新连接取代则不上报 crashed」早退。
- 守护：新增 `test/mcp-cache-retire.test.mjs`（**16/16**），含一条**反向自检**
  （用「无条件删除」的旧实现跑同一用例必须失败，证明断言不是哑的）。

### P1-C 窗口口径两份真值 → 压缩器把刚读过的内容抹掉〔存量〕

- 形态：provider 用真实 `prompt_tokens` 证伪声明窗口后，闸门按抬高值（131072）判定；
  但**压缩成功会把 `lastPromptTokens` 清成 `null`**，下一轮 pre-call 压缩拿不到反推依据，
  只能退回**声明值（32768）** ⇒ 闸门认为「90k 没事」，压缩器认为「2.7 倍超标」，
  进 aggressive 档把尾部保留压到 15%（≈19k → 更少），刚读过的文件内容被抹掉，模型只能重读。
- 修复：窗口**只在闸门定一次**（`runCtxWindow`），经 `compactHistory(..., { window })`
  下发给全部 3 个调用点；`onBudget` 上报改用同一口径（此前上报的是声明值）。
- 守护：`test/context-econ.test.mjs` 新增 2 条 —— 给定窗口时按它判定（chat 调用 0 次）、
  给更小窗口时仍然压缩（证明窗口是生效参数而不是摆设）。

### P2-D `redactSecrets` 两个实证缺陷〔存量，本轮由写测试时复现〕

- ① **把匹配偏移当前缀**：`String.replace` 的 replacer 在只有一个捕获组时签名是
  `(match, g1, offset, s)`，写成 `(m, p1, p2)` 会把 **offset 当 p2**：
  ```
  实测："Authorization: Bearer abcdefghijklmnop" → "Bearer24***"（24 = 匹配起点偏移）
  "export FOO=sk-abcdefghijklmnopqrst" → "sk11***"
  ```
- ② **值用 `\S+` 吃掉 shell 分隔符**：
  ```
  实测："export TOKEN=abc;npm test" → "export TOKEN=*** test"
  ```
  分号被吞 ⇒ R2「改完代码跑过测试吗」拿到一条**不存在的命令**，误报与漏报同时出现。
- 修复：改命名组；值只吃到空白与 shell 分隔符（`[^\s;&|()<>"']+`）。
- 复测：`Bearer ***` / `***;npm test` / `--password=*** -c "select 1"` / 无凭证命令零改动。
- 守护：`test/verifier-rules.test.mjs` 新增 3 条（偏移伪影 / 分隔符保留 / 不误伤）。

### P2-E L3 台账 `name` 无上限 → 缩容循环缩不动

- 形态：`buildL3Messages` 的超限处理是「逐级缩字段」（缩 answer、缩条数），**不缩单条字段**；
  `mcp__<server>__<tool>` 这类工具名由外部服务端决定，60 条超长 `name` 就能把 payload
  顶过 `L3_MAX_INPUT_CHARS`，两条缩容循环都以「已无可缩」告终 ⇒ 白付一次模型调用。
- 修复：`name` 限 128 字符（与 `sanitizeToolName` 同档）。

### P2-F workerPool 未过滤子代理事件 → R2 假绿

- 形态：`spawn_subagent` 的事件带 `sub: true`，worker 通道的 `onTrace` 未过滤 ⇒
  子代理跑过的测试被算进 **worker 自己的**台账，L1 的 R2「跑过测试吗」于是假绿。
- 修复：`main/workerPool.js` 的 `onTrace` 加 `if (evt && !evt.sub)`。

### P2-G i18n 双花括号不插值 → UI 上多一层括号

- 形态：插值器只认 `{name}`，文案写成 `{{tool}}` 不会被替换，而是命中**内层** `{tool}` ⇒
  渲染成 `{shell}`。既不报缺 key、也不算硬编码，`i18n-scan` / `i18n-modcheck` 全绿。
  本轮 6 条新文案（zh/en 各 3）正好踩中 —— 这是「执行后告知」这条用户可见链路上的文案。
- 修复：语料改回约定写法（单花括号）；插值器**同时容忍**双花括号（让「作者手滑」不再变成缺陷）。
- 守护：新增 `test/i18n-placeholder.test.mjs`（3/3）——
  语料禁 `{{x}}` + zh/en 同 key 占位符集合必须相等（本轮比对 **1598** 条）
  + 「比对数为 0 则判红」的反向自检（防扫描域为空导致恒绿）。

### P2-H 渲染层三处小缺陷

| 缺陷 | 形态 | 修复 |
|---|---|---|
| `approval_notice` 订阅用首帧 `tr` | effect 依赖 `[]`，闭包捕获首帧 t；切语言后仍说旧语言（注释里的承诺从未成立） | 改用 `tGlobal`（非 React 回调专用通道） |
| `Modal` 的 `closeOnEsc` 进 deps | 调用方在「内层弹层打开时」改它会**在弹窗开着时重装 effect**：弹出 stack、焦点还给外部按钮、再 push 回栈尾 ⇒ 父弹窗跑到栈顶压住子对话框，Esc/Tab 失效 | 改 ref 并移出 deps |
| `Modal` 开箱焦点用 `querySelector('[autofocus]')` | React 不写 `autofocus` 属性 ⇒ 选择器恒不命中；且无条件 `focus()` 会**抢走**子元素 `autoFocus` 抢到的焦点 | 改为「已在面板内就不抢」，选择器补 `[data-autofocus]` |
| `EcosystemModal` 遮罩点关 | 面板内有表单草稿，误点遮罩即丢全部输入 | `closeOnOverlay={false}` |

---

## 4. 复核后**不成立**的候选（这一节是下一轮的时间预算依据）

| 候选 | 判定 | 复核方式 |
|---|---|---|
| 「provider 地址输入框强制 `https://`，导致本地 Ollama `127.0.0.1:11434` 连不上」 | ❌ **不成立** | 只是一句提示文案 `providerUrlPlaceholder`；全仓 grep 无任何 URL 规范化/前缀补全逻辑 |
| 「`approval-notice` 的 ②只读 / ③L1 两条断言被遮蔽」 | ❌ **不成立** | ②在 `if (!level) return null` 就返回、③在 L1 分支返回，**都不经过** `needsApproval`；①已用 `auto-safe` 隔离 |
| 「内置员工的编辑按钮点了必然失败」 | ❌ **未证实** | `main/ecosystem.js` 里没有「内置/非内置」这个概念（grep 无 `builtin`），前提不成立 |
| 「`approval-notice-wiring` 的占位符断言因改成 `{{}}` 而空转」 | ⚠️ 部分：该套件**不按字面**比对 `{{}}`，14/14 仍有效；但为免后人误判，语料已统一回单花括号 | 直接跑该套件 |

> 记录这些**不是**为了辩解，而是为了不再重复检查同一批候选。是否成立必须给命令，不给命令的「疑似」不进下一轮清单。

---

## 5. 仍未修 / 已知限制

| 项 | 性质 | 为什么不修 |
|---|---|---|
| 定时任务通道无 V 层入口 | 设计未覆盖 | 需要先定「无人值守通道该不该花一次模型调用」，属产品裁决 |
| J3 默认不接线（`l3Chat` 未注入） | 有意为之 | 每个 run 多一次 LLM 调用，默认关闭；能力已就绪、开关在宿主 |
| 换壳 8/9 | 视觉收尾 | 本轮未重新清点（见 §2.1） |
| `notifyExecuted` 的 `reversibleNote` 是主进程侧中文 | i18n 覆盖缺口 | 主进程无法读渲染层语料；正确解法是发 `noteCode` 由渲染层翻译，需改事件契约 |
| `textKey` / `textParams` 死字段 | 维护项 | 非桌面宿主未见消费方；删除需确认外部契约 |
| `main/mcpClient.js` 800/800 raw | **硬约束** | 软档已写满：**下一次改动前必须先拆模块**，否则加一行即红 |
| 401 类不可重试错误会多等一次退避 | 性能 | 需引入「错误分类 → 退避策略」映射，属 P3 |

---

## 6. 门禁与测试增量

| 套件 | 条数 | 守什么 |
|---|---|---|
| `mcp-cache-retire.test.mjs`（新增） | 16 | 按身份摘除 / 先关传输 / 旧进程不得把新连接标成 crashed（含反向自检） |
| `i18n-placeholder.test.mjs`（新增） | 3 | 语料禁 `{{x}}` / zh-en 占位符集合相等 / 扫描域非空 |
| `context-econ.test.mjs`（+2） | 42 | 压缩必须接收调用方给定的有效窗口 |
| `verifier-rules.test.mjs`（+3） | 33 | 脱敏偏移伪影 / 分隔符保留 / 不误伤 |

套件总数 168 → **170**；基线 **170/170 通过**，typecheck 0 error，eslint 0 error / 155 warning。

---

## 7. 过程复盘：本轮差点犯的两个错

**① 按「没收到正文的审查结论」动手。**
本轮多路审查员只回了「已完成」通知，正文没到。我一度准备按记忆里的结论直接改代码。
改成「逐条自己跑命令复现」之后，4 条候选当场被证伪（§4 前三行）——
其中「强制 https」如果照改，会把本地 Ollama 这条产品核心能力弄坏。

> 纪律：**审查员的结论是线索，不是证据。** 采纳前必须有自己跑出的输出。

**② 修完不做「主路径正样本」。**
契约宽容化改完后我先跑的是「非法输入被放行」，但真正该先跑的是「合法输入仍然合法」。
本轮已补：`level:'l3' + 额外字段` 必须原样透传（否则「更严」就会变成「全拒」，
这个坑本项目 2026-10-17 已经用一次 P0 付过学费）。

---

## 8. 下一步建议（按性价比排序）

1. **给 `main/mcpClient.js` 拆模块**（已 800/800，任何改动都会红）。
2. 定时任务通道接 V 层（需产品先定「是否接受每任务一次额外模型调用」）。
3. `reversibleNote` 改 `noteCode`（主进程发码、渲染层翻译），补齐 i18n 覆盖缺口。
4. 剩下的都是 P3：换壳收尾、错误分类退避、死字段清理。
