# MJCode 远程 MCP 接入说明（WorkBuddy 目录）

| 项 | 值 |
|---|---|
| 时间 | 2026-10-17 |
| 起因 | 「大量需要授权的 MCP 服务有问题」——点了配置也连不上，或连上后 401 |
| 结论 | 有 **2 个真 bug**（不是授权问题），已修；并从 WorkBuddy 目录导入 **214 条**真实服务定义 |
| 当前目录 | 精选 **77** 条（原 80，已按用户要求移除 ima / Ardot）+ 导入 214 条 = **合并 291 条** |
| 实测可用 | 免鉴权可直接用的一小部分；**约 82% 需要令牌**（这是服务方的要求，不是客户端缺陷） |

---

## 1. 两个真 bug（这才是"连不上"的主因）

### 1.1 SSE 行尾只认 `\n\n`，CRLF 服务端全部超时

| 项 | 内容 |
|---|---|
| 现象 | 一部分远程 MCP 怎么点都连不上，30 秒后报「MCP initialize 超时」；另一部分正常 |
| 根因 | SSE 规范允许 `LF` / `CRLF` / `CR` 三种行尾。客户端只按 `'\n\n'` 切分事件，而 **CRLF 的事件分隔是 `\r\n\r\n`**（字节序列 `\r \n \r \n`，不含连续 `\n\n`）——事件永远切不开，响应到了却没人解析 |
| 证据 | DeepWiki（`https://mcp.deepwiki.com/mcp`）返回 `event: message\r\ndata: {...}\r\n\r\n`；24haowan 返回单 JSON ⇒ 恰好表现为"有的能连、有的不能" |
| 修复 | 累积缓冲后先归一化行尾（`\r\n`→`\n`、`\r`→`\n`）再切事件；同时处理一个事件内多行 `data:` 与流结束残包 |
| 验证 | `test/mcp-remote-transport.test.mjs`：本地起服务端造 CRLF / LF / JSON 三种形态。**反向验证过**——把实现改回旧版，CRLF 用例会挂到 30s 超时才失败 |

### 1.2 `notifications/initialized` 只对 stdio 发

| 项 | 内容 |
|---|---|
| 现象 | 部分严格实现的 streamableHttp 服务端，`tools/list` 被拒 |
| 根因 | MCP 规范要求 `initialize` 之后必须发 `notifications/initialized`。原实现只在 `transport === 'stdio'` 时发 |
| 修复 | HTTP 也发。并按 JSON-RPC 规范处理「通知没有响应」：服务端对通知回 404/405 **不视为连接失败**（只记日志），否则会把"通知被拒"误报成"连不上" |

### 1.3 顺带修的第三个：填了 key 仍 401

`remotePayload` 原先只认 `values.Authorization` 一个 header。而真实连接器用的是各种模板：

```
X-Api-Key: ${API_KEY}
Authorization: Bearer ${API_KEY}
X-Goog-Api-Key: ${GOOGLE_KEY}
```

用户填了 key，注入不到对应 header → 服务端只看到空值 → 恒 401，而界面显示"已配置"——**静默失败**。现在按 `install.headers` 模板逐条替换，缺变量时**不发半截模板**（发 `Bearer ` 比不发更难排查）。

---

### 1.4 第四个：key 放在 URL query 里的服务，替换不了

| 项 | 内容 |
|---|---|
| 现象 | 一类服务（如 Tushare）的 key 不在 header，而在地址里：`https://api.tushare.pro/mcp/?token=${TUSHARE_TOKEN}` |
| 根因 | `remotePayload` 只替换 headers。URL 里的占位符原样发出 ⇒ 服务端收到字面量 `${TUSHARE_TOKEN}` ⇒ 恒 401 |
| 影响面 | 导入目录里 **6 条**（Tushare、智慧芽、国泰安等），初版全被标成"可直接连接" |
| 修复 | ① `remotePayload` 同时替换 URL；② 占位符收集改为 **headers + url**；③ 任一必需变量缺失时 `remotePayload` 返回 `null`，不再发空 token 去请求；④ 导入脚本以 `url + headers` 判定 `auth_mode` |

> 这三条（1.2/1.3/1.4）叠加起来，正是"大量需要授权的 MCP 用不了"的完整解释：**协议解析、通知缺失、注入位置不对**，三个都不是授权本身的问题。

---

### 1.5 第五个：`type: sse` 的服务此前直接没有入口

| 项 | 内容 |
|---|---|
| 现象 | 目录里有 11 条是旧版 HTTP+SSE（`GET /sse` 建流），客户端只有 streamableHttp，导入时被整体跳过 |
| 差异 | streamableHttp 是"一个 POST 一个响应"；SSE 是"GET 建一条长连接 → 服务端用 `event: endpoint` 告知投递路径 → POST 到该路径，响应从长连接回来"。两者不能共用一个 transport |
| 修复 | 新增 `createSseTransport`：GET 建流、解析 `endpoint`（支持相对路径）、POST 投递、401 转「需要授权」、流断开标记不可用；`consumeSse` 增加命名事件支持（endpoint 的 data 不是 JSON） |
| 顺带修 | 导入器把 sse 归错到 stdio 分支，漏收 url 占位符（`?key=${TENCENT_MAP_KEY}`）→ 已改为 URL 类传输统一收 `headers + url` |

---

### 1.6 第六个：「+」菜单把鉴权输入框写死成 `Authorization`

| 项 | 内容 |
|---|---|
| 现象 | 点需要授权的 MCP，弹出输入框，标签却写「Authorization」，而模板变量叫 `API_KEY` / `X-Api-Key` / `TUSHARE_TOKEN` |
| 后果 | 用户填了 key，键名不匹配 → 注入不到 header/URL → **怎么填都连不上**（这是"授权类服务有问题"最直接的一条） |
| 根因 | 配置弹窗（`ConnectorConfigDialog`）一直是按 `missing[]` 渲染的，而 `+` 菜单的 needs-auth 分支写死了一个 `Authorization` 输入框 |
| 修复 | `+` 菜单改为按 `plan.missing` 逐项渲染（label / docs_url / placeholder 都来自目录），与配置弹窗一致 |

---

## 2. 数据接入：214 条从哪来

| 项 | 值 |
|---|---|
| 来源 | 本机 `~/.workbuddy/connectors-marketplace/connectors/`（270 个目录 / 229 个服务定义） |
| 处理 | `desktop/scripts/import-workbuddy-connectors.mjs`：只读 WorkBuddy 目录，**不碰凭证**；生成 `ecosystem/mcp-connectors-workbuddy.json` |
| 结果 | 导入 **214 条**（remote 202 / npm 11 / uvx 1，其中 **11 条走 SSE**），跳过重复 1、manual 无字段 2 |
| 为什么单独存文件 | 主目录有「≤90 条」的收敛门禁（`test/connector-catalog.test.mjs` 守护，防止目录再膨胀成"一堆点不动的条目"）。导入走第二来源，由 `main/ecosystem.js` 合并加载、**精选优先**去重 |
| 幂等 | 脚本每次整体重写该文件，可反复运行；新增条目 id 前缀 `wb-` |

数据管道细节：

- `type: streamableHttp|http` → `transport: http`，`install: {type:'remote', url}`
- `type: stdio` + `npx/uvx/docker` → `install: {type:'npm'|'uvx'|'docker', pkg, args}`
- `headers` 里的 `${API_KEY}` → `env_vars: [{name:'API_KEY', required:true}]` + `auth_mode: paste_key`
- `preAuth: 'cli'`（5 条）→ `notes` 里写入该服务自己的授权命令（见 §4）
- **版本锁定**（供应链）：WorkBuddy 的 stdio 条目普遍是 `npx -y <pkg>@latest`。导入时查 registry 的 `dist-tags.latest`，写成 `pkg@x.y.z`——同一份目录任何时间连的都是同一份代码。代价是不自动跟随上游更新，需要更新时重跑导入脚本
- **`preAuth: 'cli'`（4 条）**：把 `cli.json` 的 `auth` 命令写进 `install.auth_command`，UI 直接展示可全选的命令；依赖独立 CLI 的（`tcb` / `edgeone` / `ioacloud-cli`）额外提示「需要先安装该命令行工具」
- `token-schema.json`（94% 的目录都有）→ 合并进 `env_vars`：中文 `label`、`docs_url`（点「如何获取」直达官方文档）；`placeholder`（"去哪拿 key"的具体步骤）写进 `notes`，因为 MJCode 的表单只渲染 label / docs_url
- `type: sse`（11 条）→ `transport: 'sse'`，已导入（客户端实现了 GET 建流 + POST 投递）；`--no-sse` 可关闭

---

## 3. 四档可用性（实测，不是估计）

对导入的 143 条"目录未声明鉴权"的 remote 端点采样 40 条实测：

| 档位 | 数量 | 用户要做什么 |
|---|---|---|
| **A 免鉴权，直接可用** | 采样 12.5%（约 5/40，如 `24haowan` 8 工具、`fbs-connector` 30 工具） | 点连接即可，工具立刻进对话 |
| **B 需要填变量**（**53 条**：header 模板 / URL query / SSE 的 query） | 面板填 `API_KEY` 等 → 按模板注入 header 或 URL；缺项时按钮不会发出空请求 | 表单会显示中文 label，点「如何获取」跳到官方文档 |
| **C 需先跑官方授权 CLI**（5 条，`preAuth: 'cli'`） | 终端执行一次该服务的 `auth` 命令，登录态由 CLI 自己保存 | 之后用 stdio 启动同一 CLI，**复用其登录态**，无需在 MJCode 填 key |
| **D 需要令牌但目录没声明** | 约 82%（33/40 返回 401） | 去该服务官网/开放平台取 token，填 `Authorization` |

> D 档占大多数，这是**服务方的鉴权要求**，不是客户端能绕过的。MJCode 能做的是：把 401 如实显示成"需要授权"，并在条目 `notes` 里写清下一步。

---

## 4. 为什么不能直接复用 WorkBuddy 的授权

只读探查结论（未修改 `~/.workbuddy` 任何内容）：

| 事实 | 影响 |
|---|---|
| `~/.workbuddy/connectors/<account>/.credentials.v3.json` 只存 `encryption` 元信息（AES-256-GCM + HKDF + salt + keyCheck），**令牌本体由系统密钥加密** | 无法解出明文令牌 |
| `mcpClientInfo` 只有 1 条（`agentkey`） | OAuth 动态注册信息几乎为空 |
| `connector-states.v3.json` 的 `everConnected` 仅 `custom-mcp:ardot`，且该条已被用户禁用 | **WorkBuddy 侧实际几乎没有已授权的 MCP** |

所以"从 WorkBuddy 拿 token 给 MJCode 用"这条路在数据上是空的——不是没做，是没东西可拿。

---

## 5. 怎么用（三步）

1. **打开生态中心 → 连接器**，会看到精选 77 条 + `vendor: WorkBuddy 目录` 的 214 条。
2. **选一个**：
   - 免鉴权的直接点「连接」→ 右侧工具面板出现 `mcp__<server>__<tool>`；
   - 需要 key 的按表单填（表单会问你模板里声明的变量名，不再是硬编码的 `Authorization`）；
   - `preAuth: 'cli'` 的，先在终端跑条目备注里的授权命令（如 `npx -y @xxx/mcp auth`），再回 MJCode 连接。
3. **在对话里直接用**：连接成功后 `mjcode:mcp-tools-dirty` 触发工具集重建 → `agent:run` 带上 `mcpTools` → 模型可见 `mcp__*` 工具；调用时走 L3 审批（MCP 工具永不免批）。

---

## 6. 验证

| 项 | 命令 | 结果 |
|---|---|---|
| 传输层（CRLF/LF/JSON/401） | `node test/mcp-remote-transport.test.mjs` | **6/6** |
| 目录质量（203 条） | `node test/workbuddy-catalog.test.mjs` | **11/11** |
| header 模板注入 | `node test/connector-launch.test.mjs` | **25/25** |
| 导航守卫（本次 bug） | `node test/navigation-guard.test.mjs` | **7/7** |
| SSE 传输 | `node test/mcp-sse-transport.test.mjs` | **7/7** |
| 表单字段 + 版本锁定 | `node test/connector-form-fields.test.mjs` | **7/7** |
| 全量 | `npm test` | 见下 |

端到端实测（真实网络）：

```
① 3chat 模板注入：空值 → needs-auth(API_KEY)；填 sk-demo-123 → Authorization: Bearer sk-demo-123
② 24haowan：ready → 连上，8 个工具
③ deepwiki（SSE/CRLF）：连上，3 个工具（ask_wiki_question / read_wiki_contents / read_wiki_structure）
```

---

## 7. 边界（如实记账）

| 项 | 说明 |
|---|---|
| SSE 传输（11 条） | **已适配**（`createSseTransport`）。仍有一类情况会失败：服务端已下线 `/sse` 端点、只保留 streamableHttp——这时按条目备注换地址即可 |
| DNS rebinding | 与本功能无关，但 `server/src/lib/urlGuard.js` 的 SSRF 校验仍有 TOCTOU 窗口 |
| 其余 82% 的 401 | 需要用户自备令牌；客户端只能保证"填了能注入、失败有话说" |
| WorkBuddy 目录更新 | 需要重跑 `node scripts/import-workbuddy-connectors.mjs --write` 同步（脚本幂等） |
