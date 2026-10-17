# 签名 / 公证 / 自动更新演练 Runbook（T2-7）

> 适用：MJ Coder 桌面端（desktop/，electron-builder + electron-updater）。
> 关联：CI release job（.github/workflows/ci.yml，secrets 就位即自动启用签名）、
> 回滚流程见《发布回滚Runbook.md》、更新失败诊断文案见 `main/updater/index.js`（classifyUpdateError）。
> 纪律：**生产包只从 CI 产出**；本地 build 仅用于演练验证，不直发。

## 一、现状与开关

| 能力 | 现状 | 启用方式 |
| --- | --- | --- |
| macOS 代码签名 | 默认关闭（无证书时 electron-builder 自动跳过，CI 仍绿） | secrets：`CSC_LINK`（Developer ID Application p12 的 base64）+ `CSC_KEY_PASSWORD` |
| macOS 公证（notarization） | **未配置**（credentials 就位后按下方片段开启） | secrets：`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` |
| Windows 代码签名 | 默认关闭 | secrets：`CSC_LINK`（pfx base64）+ `CSC_KEY_PASSWORD` |
| 更新源 | GitHub Releases（`build.publish` owner/repo） | 仓库 Variables：`PUBLISH_RELEASE=true` |

electron-builder 行为：未配置 secrets → 产出未签名包（演练可用）；配置后 → 自动签名 + 公证。

## 二、macOS：公证配置片段（证书就位后合入）

> **2026-10-17 已更新（commit 5325188）**：`entitlements` / `entitlementsInherit` 与
> `desktop/build/entitlements.mac.plist` **已经内置并接线**，下面片段里这两行不必再加，重复添加会覆盖为同值但属冗余。
> 证书就位后仍需补的是 `hardenedRuntime` / `gatekeeperAssess` / `notarize` 三项（三平台签名变量也已按平台分流：
> `CSC_LINK_MAC` / `CSC_LINK_WIN`，旧的单变量 `CSC_LINK` 仍作为回落值有效）。

`desktop/package.json` 的 `build.mac` 增加：

```json
"mac": {
  "category": "public.app-category.developer-tools",
  "target": "dmg",
  "icon": "renderer/src/assets/logo.png",
  "artifactName": "MJCode-${version}-${os}-${arch}.${ext}",
  "hardenedRuntime": true,
  "gatekeeperAssess": false,
  "entitlements": "build/entitlements.mac.plist",
  "entitlementsInherit": "build/entitlements.mac.plist",
  "notarize": { "teamId": "<APPLE_TEAM_ID>" }
}
```

`build/entitlements.mac.plist` 最小集（本地优先 Agent 的工具执行需要子进程与 JIT）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

> 说明：`disable-library-validation` 是 Electron 加载未签名原生模块（better-sqlite3）的通行做法；
> 若后续全部依赖签名，可移除以收紧安全边界。

## 三、Windows：代码签名方案

优先级二选一（证书成本递增，信任度递增）：

1. **Azure Trusted Signing（推荐起步）**：月费低、支持 EV 等效信任。
   - 准备：Azure 订阅 + 实名认证 + 代码签名账户（Account）+ 证书配置文件（Profile）。
   - CI 接入：electron-builder 24+ 支持 `azureSignin` / `trustedSigning`（`build.win.sign` 自定义脚本调用 `trusted-signing`），或先用自签 pfx 走 `CSC_LINK` 路径验证链路，再切 Trusted Signing。
2. **传统 EV/OV 代码签名证书（DigiCert/Sectigo/GlobalSign）**：购买 pfx → base64 进 `CSC_LINK`，`CSC_KEY_PASSWORD` 进 secrets，electron-builder 自动 `signtool`。EV 证书可即时豁免 SmartScreen 信誉积累。

未签名 Windows 包的现实：SmartScreen 警告「未知发布者」——首次安装用户量大时必配签名。

## 四、0.x → 0.x+1 真机升级演练步骤

前置：两台干净机器（或干净用户目录），分别装旧版与新包。

1. **发布演练源**：推 tag `v0.x+1` → CI release job 三平台打包 → `PUBLISH_RELEASE=true` 时自动上 GitHub Release（`latest-mac.yml` / `latest.yml` 为更新源真值）。
2. **旧版检查更新**：设置 → 账户与更新 → 「检查更新」：
   - 期望：状态「发现新版本 0.x+1」；**不自动下载**（autoDownload=false 纪律，下载需用户确认）。
3. **下载与安装**：点「重启安装」→ 应用退出 → 新版本启动：
   - macOS 期望：新包可启动且 Gatekeeper 不拦截（公证生效标志：`spctl -a -vv <App>` 通过；`spctl` 失败但直接打开成功 = 未公证）。
   - Windows 期望：SmartScreen 无「未知发布者」（签名生效标志）。
4. **数据连续性**：升级后打开原会话——本地数据（local-data.json / SQLite / traces）完好，模型配置与 API Key 仍可用（凭证加密轨未断）。
5. **回滚验证**：按《发布回滚Runbook.md》把 `latest-mac.yml` 指回旧版 → 旧版「检查更新」显示「已是最新版本」。

## 五、异常场景清单（必须不静默）

| 场景 | 期望表现（classifyUpdateError 分类） | 验证方法 |
| --- | --- | --- |
| 断网/服务器不可达 | kind=network：「无法连接更新服务器…不影响当前版本使用」 | 检查更新时拔网线 |
| 更新包损坏/被替换 | kind=integrity：「更新包校验失败…请勿继续安装，手动下载官方包」 | 篡改 release 资产 digest（演练仓库） |
| 更新源未就绪/通道错 | kind=notfound：「未找到可用的更新发布」 | 指向空仓库通道 |
| 安装权限不足 | kind=install：「安装前置失败…退出应用后重试」 | 安装时占用应用目录 |
| 其他未知失败 | kind=unknown：指向「设置 → 问题诊断」导出诊断包 | 单测已覆盖（test/updater-errors.test.mjs） |

## 六、演练记录

| 日期 | 版本对 | 平台 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 2026-10-15 | — | — | 未执行 | 代码侧已就绪（分类文案/手动下载兜底/诊断包闭环）；真机演练需 Apple 开发者账号与 Windows 证书就位后按本 Runbook 执行 |

> 每次真机演练后**必须**在本表追加一行（日期/版本对/平台/结果/备注），并同步 CHANGELOG。
