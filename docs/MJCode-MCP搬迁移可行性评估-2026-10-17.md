# 把 WorkBuddy 的 MCP 服务搬到 MJCode：可行性评估

| 项 | 值 |
|---|---|
| 问题 | 用 WorkBuddy 目录里的 MCP 服务替换/补充 MJCode 的连接器，只搬开源的，内置的不动，按 WorkBuddy 的加载方案实现——是否可行 |
| 结论 | **"搬服务"可行且已落地（203 条）；"替换内置连接器"不可行也没必要；"只搬开源"只能筛出 6 条；skillhub 方案可行但只有 27 条、且不给配置** |
| 依据 | 本机实测：目录交集、34 条现有远程的连通性、12 个 npm 包的 license |

---

## 一、结论拆成三句

1. **搬过来：可行，已经做完 203 条。** 从 `~/.workbuddy/connectors-marketplace/connectors/`（270 目录 / 229 服务，只读）导入 203 条，落 `ecosystem/mcp-connectors-workbuddy.json`，由 `main/ecosystem.js` 与精选目录合并加载。端到端验证过：目录 → 启动计划 → 连接 → 拿到工具（24haowan 8 个、deepwiki 3 个）。
2. **替换：不可行。** 两套目录**交集为 0**（按地址、包名、名字三种键比对，一条都不重合）；而且现有 80 条**没有一条地址写错**（见第二节实测）。没有可替换的对象，也没有需要替换的坏条目。
3. **"只要开源就搬"：标准可执行，但只筛出 6 条。** 203 条里 191 条是**商业托管端点**（不是软件，谈不上开源），11 条 npm 里只有 3 条 MIT、3 条 Apache-2.0，其余 4 条 UNKNOWN、2 条自定义/私有。

---

## 二、三组硬数据

### 2.1 两套目录交集为 0

| 键 | 现有 80 | 导入 203 | 交集 |
|---|---|---|---|
| 安装地址 / 包名 / 名字 | 80 | 203 | **0** |

原因：两批定位不同。现有 80 条是 Anthropic 官方 server + 海外大厂 SaaS（github / gitlab / notion / stripe / supabase / postman…，其中 **72 条 `official: true`、63 条 `stable`**）；WorkBuddy 目录是国内 SaaS（24haowan / 58pic / canva / camscanner / 政务与行业服务…）。

所以"用 WorkBuddy 替换我的连接器"在数据上不成立——**它是另一批服务，不是同一批的更好版本**。

### 2.2 现有 34 条远程：没有一条地址错

逐条实连（同一客户端、同一网络）：

| 分类 | 条数 | 明细 |
|---|---|---|
| 免鉴权可用 | **5** | deepwiki(3 工具)、git-mcp(5)、browserbase(6)、aws(8)、context7(2) |
| 需要令牌（401/403） | **21** | github、gitlab、notion、slack、linear、sentry、stripe、figma、neon、vercel…（SaaS 的正常要求） |
| 网络不可达 | **5** | huggingface、gmail、drive、calendar、bigquery —— **DNS 全部解析正常**，是链路被阻断，换地址解决不了 |
| 本地端口服务 | **2** | figma-devmode(`127.0.0.1:3845`)、ardot-local(`127.0.0.1:50501`) —— 需要本机对应应用在跑，条目本身没错 |
| 误判 | **1** | hubspot 单独复测是 401，属"需要令牌" |

**结论：现有连接器的定义是对的。** 用户感知的"很多用不了"，真实构成是「21 条要自己配令牌」+「5 条网络环境不通」+「2 条要本机应用」，不是定义坏了。

### 2.3 license 只能覆盖 12 条

| 结果 | 条数 | 例子 |
|---|---|---|
| MIT | 3 | `@cloudbase/cloudbase-mcp`、`edgeone-pages-mcp-fullstack`、`@laiye-adp/mcp` |
| Apache-2.0 | 3 | `@ioacloud/ioacloud-mcp`、`jufa-mcp-server`、`@harrylabsj/kiwi` |
| UNKNOWN | 4 | `@infimind-next/ai-hive-mcp`、`dcs-cloud-mcp-server`、`@mastergo/vibe-mcp`、`mcp-server-weisheng-scrm` |
| 自定义 / 私有 | 2 | `zw3d-mcp`（SEE LICENSE IN LICENSE）、`zwcad-mcp`（registry 404） |
| 不适用 license | 191 | 商业托管端点（remote URL） |

---

## 三、"开源就可以搬"这个标准怎么落地

要区分两件事，它们的法律含义完全不同：

| 行为 | 含义 | 风险 | 建议 |
|---|---|---|---|
| **连接公开端点** | 用户的客户端连第三方 SaaS 的公开 MCP 地址，用户自备令牌 | 低（端点本来就是给客户端用的） | 可做，已在做 |
| **分发开源 server 代码** | 把 MIT/Apache 的 MCP server 打包进安装包 | 低，但需保留版权与许可声明 | 仅限那 6 条，且要附 LICENSE |
| **再分发目录元数据** | 把厂商的名称、描述、图标、字段说明打包进你的产品分发 | **中**（目录是对方资产，多数 ToS 不允许转载） | 不建议内置；改为运行时读取或只存 URL + 自写中性描述 |

> 本机 WorkBuddy 目录里**没有 terms/license 文件**（只有 `mcp.json` / `cli.json` / `token-schema.json` / `skills/`），所以"是否允许搬"无法从数据判定，只能看各家 ToS。这也是不建议把 203 条文案内置分发的原因。

---

## 四、真正的方案不是"替换"，是"分级共存"

| 层级 | 范围 | 处置 | 理由 |
|---|---|---|---|
| **L0 内置** | 72 条 `official: true` | **不动** | 你说"系统内置的不要随便删除"，这些正是 |
| L1 现有非 official | 8 条 | 只补 `notes`，不改地址 | 实测无地址错误 |
| L2 导入目录 | 203 条（已在） | 按可用性分四档展示（见 §5） | 扩充可选面，不污染精选 |
| L3 开源可分发 | 6 条 MIT/Apache | 单独标注 license + 仓库地址 | 唯一可"搬代码"的一档 |

**建议的替换语义**（如果你仍希望"用更好的定义覆盖"）：只做「同地址/同包名」的字段级更新（补 headers 模板、补 auth 引导），不做整条替换。当前交集为 0，这条规则暂时不会触发，但留着是对的——将来 WorkBuddy 目录更新时可能命中。

---

## 五、按 WorkBuddy 的加载方案实现：对齐到哪一步

| WorkBuddy 形态 | 数量 | MJCode 现状 |
|---|---|---|
| `type: streamableHttp` + url | 185 | 已支持（本轮修好了 CRLF 与 initialized） |
| `+ headers: {"X-Api-Key": "${API_KEY}"}` | 48 | 已支持（本轮修好模板注入） |
| `type: stdio` + `npx/uvx` | 11 | 已支持（映射为 npm/uvx install） |
| `preAuth: "cli"`（先跑授权命令） | 4 | **仅写进 notes**，没有"引导执行 + 检测登录态"的闭环 |
| `type: sse`（GET /sse + POST /messages） | 11 | **未支持**，未导入 |
| `token-schema.json`（字段 label / placeholder / docUrl） | 8 | **未合并**：MJCode 的 `env_vars` 只吃 `name/label/docs_url/required`，用户看不到"去哪拿 key" |
| `runtime: {node: ">=20.19.0"}` | 若干 | **未校验** |
| `type` 缺失（靠 command 推断） | 12 | 已按 command 推断，但未逐条确认 |

所以要"完全按 WorkBuddy 的方案加载"，还差 4 件：**SSE 传输、preAuth 引导、token-schema 合并、runtime 校验**。

---

## 六、风险清单（按严重度）

| # | 风险 | 级别 | 说明与缓解 |
|---|---|---|---|
| R1 | **供应链**：11 条 npm 是 `npx -y <pkg>@latest` | **高** | 用户点"连接"就会下载并执行第三方代码，且 `@latest` 无版本锁定、无完整性校验。缓解：锁版本 + 首次连接显式确认 + 只对 MIT/Apache 放行 |
| R2 | 82% 端点需令牌（实测 33/40 返回 401） | 高 | 无法用技术绕过；只能把引导做对（docUrl / placeholder / 明确 401 文案） |
| R3 | 目录元数据再分发 | 中 | 见 §3；建议运行时读取，不内置文案 |
| R4 | 第三方端点无 SLA、随时改协议 | 中 | 连接失败要有可读原因（已做 401/超时区分）；不要把导入条目设成 `recommended` |
| R5 | SSE 11 条未适配 | 低 | 已在条目里标注"连接会失败"，不制造假可用 |

---

## 七、如果继续推进，建议的顺序与工作量

| 批次 | 内容 | 为什么先做 | 量级 |
|---|---|---|---|
| P0 | **token-schema 合并**（8 条） | 直接解决"不知道去哪拿 key"，是用户最初的痛点；纯数据映射 | 0.5 天 |
| P1 | **SSE 传输**（11 条） | 补齐第 4 种加载形态；有本地 fake server 可测 | 1 天 |
| P2 | **preAuth 引导**（4 条） | 检测 CLI 是否已登录 → 没登录就给出命令与"重新检测"按钮 | 0.5 天 |
| P3 | **供应链加固** | 版本锁定 + 首次连接确认 + license 白名单（仅 6 条可分发） | 1 天 |
| P4 | runtime 校验 + 12 条无 type 条目逐条确认 | 收尾 | 0.5 天 |

---

## 八、方案 C：直接用 skillhub 的插件远程加载

实地探过（`/plugins` 路由其实回落到 SPA，真实入口是 `/mcp`），结论如下。

### 8.1 它的真实形态

| 项 | 事实 |
|---|---|
| 数据接口 | `https://api.skillhub.cn/api/v1/mcp/servers`（公开，无需 token），另有 `/mcp/categories`、`/mcp/servers/<slug>` |
| 规模 | **27 条**，`publisherType` 全部是 `tencent`（CLS、TAPD、DNSPod、腾讯文档、位置服务、微伴、TDesign…） |
| 字段 | `name / summary / category / publisher / iconUrl / repoUrl / sourceUrl / readme{cosKey, sha256, size} / stats` |
| **没有的字段** | **没有 install 配置**——没有 url、没有 command、没有 env、没有 headers |
| README | 在腾讯 COS 上（`skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/mcp/<slug>/README.md`），**带 sha256 可校验** |

也就是说：skillhub 是**索引 + 文档**，不是配置分发。它告诉你"有这个服务、文档在哪、原站在哪"，但**怎么启动要自己从 README 里读**。

### 8.2 README 能不能可靠解析（实测 27 条）

| 结果 | 条数 | 说明 |
|---|---|---|
| 能提取出标准 `mcpServers` JSON 块 | **16** | 如 `cls-mcp-server` 的 README 里有 4 处配置块 |
| 只有 `npx ...` 命令行形态 | 约 5–8 | 如 `tdesign-mcp-server`（536B，只写 `npx`） |
| 结构不统一 / 段落缺失 | 3 | 如 `mcp-server-dnspod` 有 mcpServers 但块被截断 |

综合：**"含可用配置信息"约 80–90%，但形态不统一**。要覆盖，需要多策略提取（JSON 块 → `npx/uvx` 命令行 → 表格），并且 27 条**人工过一遍**最稳。

> 这正是"按每个插件的实现思路"的字面含义：**一条一条按它的写法适配**，不是一个通用加载器能全自动搞定的。

### 8.3 与现有两套目录的重叠：几乎为 0

按 name / slug / 包名比对：与现有 80 条、WorkBuddy 203 条**基本不重合**（唯一命中是通用词 `mcp` 的误匹配）。

所以它是**纯增量**，但增量只有 27 条，且集中在腾讯生态。

### 8.4 三套来源对比

| 维度 | 现有精选 80 | WorkBuddy 203 | skillhub 27 |
|---|---|---|---|
| 规模 | 80（≤90 门禁） | 203（269 目录去重后） | 27 |
| 覆盖 | Anthropic 官方 + 海外大厂 | 国内 SaaS 长尾 | **腾讯自家产品** |
| 配置来源 | 人工精修 | `mcp.json` 直接给 install/headers | **只有 README，需解析** |
| 鉴权信息 | 手写 env_vars | headers 模板 + `token-schema`（含 docUrl/placeholder） | README 里零散写 |
| 完整性校验 | 无 | 无 | **README 有 sha256** |
| 稳定性 | 仓库内，稳定 | 本机目录，随 WorkBuddy 更新 | **依赖 api.skillhub.cn + COS，无 SLA** |
| 鉴权难度 | 21/34 要令牌 | 82% 要令牌 | 腾讯云 SecretId/SecretKey（同为自备） |

### 8.5 可行性判断

| 问题 | 答案 |
|---|---|
| 技术上能不能做 | **能**。公开 API + README + sha256，写一个导入器即可（API → 详情 → README → 多策略提取 → 生成目录条目） |
| 能不能"全自动远程加载" | **不能**。API 不给配置，README 形态不统一，需要解析器 + 27 条人工校对 |
| 值不值得做 | **看目标**：要补腾讯生态 → 值得（约半天，27 条一次性整理）；要解决"大量服务要授权" → **不解决**，它同样要凭证；要海量服务 → 不如 WorkBuddy 的 203 条 |
| 风险 | 依赖第三方 API/COS（可能加鉴权、限流、路径变更）→ 必须**导入后落本地**、失败可降级；README 与图标是对方 COS 资产，展示可以，打包分发要谨慎 |

### 8.6 如果要做，建议的形态

不要做成"运行时直连 skillhub"（第三方挂了你的连接器就空），而是：

1. `scripts/import-skillhub-connectors.mjs`：拉 27 条 → 下载 README（校验 sha256）→ 多策略提取配置 → 生成 `ecosystem/mcp-connectors-skillhub.json`（与另外两套同构，`id` 前缀 `sk-`）；
2. `main/ecosystem.js` 的合并加载再挂第三个来源（精选优先，其次 WorkBuddy，再次 skillhub）；
3. 提取失败或配置不全的条目**不导入**，只在报告里列出，避免制造"点不动的条目"；
4. 每次导入留 `generatedAt` + 各条 `readmeSha256`，便于判断"上游改了没"。

---

## 九、来源选型推荐

### 9.1 六个维度打分（1–5，负向项越低越好）

| 维度 | WorkBuddy 203 条 | skillhub 27 条 | 说明 |
|---|---|---|---|
| 覆盖广度 | **5** | 2 | 203 覆盖海外大厂 + 国内长尾；27 条全腾讯系 |
| 配置可加载性 | **5** | 2 | `mcp.json` 直接给 `command/args/url/headers`；skillhub 只有 README，16/27 能解析 |
| 鉴权信息完整度 | **4** | 2 | WorkBuddy 有 48 条 headers 模板 + 8 条 `token-schema`（含 docUrl/placeholder）；skillhub 散落在 README |
| 数据源稳定性 | **4** | 3 | WorkBuddy 是本地目录（客户端自带）；skillhub 依赖 `api.skillhub.cn` + COS，无 SLA |
| 完整性校验 | 2 | **4** | 只有 skillhub 的 README 带 `sha256` |
| 集成成本 | **5**（已完成） | 2 | WorkBuddy 已导入并跑通 132 套件；skillhub 要新写解析器 + 27 条人工校对 |
| 供应链风险（负向） | 2 | 3 | 两边都有 `npx -y pkg@latest`，WorkBuddy 侧 11 条更集中 |
| 合规风险（负向） | 3 | 3 | 都是第三方元数据，都不建议整包内置分发 |

### 9.2 结论

**主来源选 WorkBuddy，skillhub 只做可选窄补充。**

理由按权重排序：

1. **可加载性差一个量级**。WorkBuddy 给的是结构化配置，拿到就能连；skillhub 给的是文档，要写解析器、要逐条适配、上游改 README 就漂。维护成本不是"多写一个脚本"，而是"长期跟着 27 份 Markdown 走"。
2. **覆盖差 7 倍**（203 vs 27），且 skillhub 全是腾讯自家产品——对非腾讯生态用户，命中率很低。
3. **WorkBuddy 已经落地**（203 条在库、合并加载、可连可进对话、132 套件全绿），沉没成本已付、收益已兑现。
4. skillhub 唯一胜出的项是 `sha256` 完整性校验——这是**值得借的机制**，但不必为此换来源：可以给 WorkBuddy 导入加"上游文件指纹"，或将来接 skillhub 时用它做高信任子集。

### 9.3 不建议的三种做法

| 做法 | 为什么不建议 |
|---|---|
| 用 skillhub 替代 WorkBuddy | 覆盖从 203 掉到 27，且从"配置"退化到"文档解析" |
| 两个都做运行时直连 | 第三方站点故障/加鉴权时，你的连接器列表会直接空掉；必须"导入后落本地" |
| 两套目录都整包内置分发 | 元数据是对方资产（WorkBuddy 侧无 terms 文件，skillhub 的 README/图标在腾讯 COS），打包分发有再分发风险 |

### 9.4 真正的瓶颈不在"选哪个来源"

两套来源实测下来，可用性瓶颈是同一件事：

| 瓶颈 | 占比 | 与来源无关的原因 |
|---|---|---|
| 需要令牌 | WorkBuddy 侧采样 **82%**、skillhub 侧腾讯云凭证 | 服务方的鉴权要求，换来源不会变 |
| 供应链 | 11 条 `npx @latest` | 无版本锁定的第三方代码执行 |
| 传输形态 | skillhub 与 WorkBuddy 都有 stdio/remote 混用 | 客户端要覆盖 4 种形态（SSE 仍缺） |

所以**优先级应该是**：

| 顺序 | 事项 | 收益 |
|---|---|---|
| 1 | 合并 `token-schema`（8 条：label/placeholder/docUrl） | 直接解决"不知道去哪拿 key"——这是用户最初的痛点 |
| 2 | SSE 传输（11 条） | 补齐第 4 种加载形态 |
| 3 | 供应链加固（锁版本 + 首次连接确认 + license 白名单） | 消除最高级别的风险 |
| 4 | skillhub 第三来源（若确有腾讯生态需求） | 新增 27 条 |

---

## 十、一句话回答

**搬服务：可行，已经做完（203 条，可连可进对话）。替换内置：不成立——两套目录没有任何交集，现有 80 条也没有地址错误，别删也别换。只搬开源：只有 6 条够格，且这 6 条能"搬代码"，其余 197 条只能"连端点"。

skillhub 那条路：**可行但是小补充**——27 条全腾讯系、API 只给文档不给配置、README 需逐条解析（16/27 能直接提取 JSON，其余要按命令行形态适配），与现有两套几乎零重叠。它适合当第三个来源补腾讯生态，不适合当"通用远程加载机制"，也不解决鉴权问题。真正的下一步仍是：把鉴权引导（token-schema）和缺少的 SSE 形态补上。**

**来源选型：WorkBuddy 当主来源（已集成、结构化、203 条），skillhub 只在需要腾讯生态时作第三来源（27 条、需解析 README）。两边的共同瓶颈是鉴权与供应链，不是来源数量——先把 token-schema 引导和 SSE 补齐，比再接一个目录有用得多。**
