const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('mjcode', {
  // App / Features
  getFlags: () => ipcRenderer.invoke('app:flags'),
  getUserDataPath: () => ipcRenderer.invoke('app:userDataPath'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  openInIDE: (payload) => ipcRenderer.invoke('app:openInIDE', payload),
  // Model
  chat: (payload) => ipcRenderer.invoke('model:chat', payload),
  abortChat: () => ipcRenderer.invoke('model:abort'),
  getSecrets: (payload) => ipcRenderer.invoke('model:getSecrets', payload),
  onDelta: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('model:delta', handler);
    return () => ipcRenderer.removeListener('model:delta', handler);
  },
  // 推理模型思考流（reasoning_content，仅展示不落库）
  onReasoning: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('model:reasoning', handler);
    return () => ipcRenderer.removeListener('model:reasoning', handler);
  },
  // Tools
  shell: (payload) => ipcRenderer.invoke('tool:shell', payload),
  readFile: (payload) => ipcRenderer.invoke('tool:readFile', payload),
  writeFile: (payload) => ipcRenderer.invoke('tool:writeFile', payload),
  editFile: (payload) => ipcRenderer.invoke('tool:editFile', payload),
  applyPatch: (payload) => ipcRenderer.invoke('tool:applyPatch', payload),
  // 文件预览（md/代码/图片/PDF/音视频）与「在系统中打开」
  previewFile: (payload) => ipcRenderer.invoke('file:preview', payload),
  openPath: (payload) => ipcRenderer.invoke('shell:openPath', payload),
  revealPath: (payload) => ipcRenderer.invoke('shell:reveal', payload),
  openExternal: (payload) => ipcRenderer.invoke('shell:openExternal', payload),
  // Git 环境信息（设置页 Git 面板：只读探测，不修改任何配置）
  gitConfig: (payload) => ipcRenderer.invoke('tool:gitConfig', payload),
  listDir: (payload) => ipcRenderer.invoke('tool:listDir', payload),
  grep: (payload) => ipcRenderer.invoke('tool:grep', payload),
  glob: (payload) => ipcRenderer.invoke('tool:glob', payload),
  // Git
  gitStatus: (payload) => ipcRenderer.invoke('tool:gitStatus', payload),
  gitDiff: (payload) => ipcRenderer.invoke('tool:gitDiff', payload),
  gitLog: (payload) => ipcRenderer.invoke('tool:gitLog', payload),
  gitBranch: (payload) => ipcRenderer.invoke('tool:gitBranch', payload),
  gitCommit: (payload) => ipcRenderer.invoke('tool:gitCommit', payload),
  gitAdd: (payload) => ipcRenderer.invoke('tool:gitAdd', payload),
  gitCheckout: (payload) => ipcRenderer.invoke('tool:gitCheckout', payload),
  gitRestoreStaged: (payload) => ipcRenderer.invoke('tool:gitRestoreStaged', payload),
  gitApplyHunk: (payload) => ipcRenderer.invoke('tool:gitApplyHunk', payload),
  // P0-E：GitHub 最小闭环（gh CLI）
  githubStatus: () => ipcRenderer.invoke('github:status'),
  githubCreatePr: (payload) => ipcRenderer.invoke('github:createPr', payload),
  sandboxStatus: () => ipcRenderer.invoke('sandbox:status'),
  // Git Worktree 隔离工作区
  createWorktree: (payload) => ipcRenderer.invoke('worktree:create', payload),
  listWorktrees: (payload) => ipcRenderer.invoke('worktree:list', payload),
  promoteWorktree: (payload) => ipcRenderer.invoke('worktree:promote', payload),
  syncWorktree: (payload) => ipcRenderer.invoke('worktree:sync', payload),
  removeWorktree: (payload) => ipcRenderer.invoke('worktree:remove', payload),
  // Dialog / Project
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  probeProject: (payload) => ipcRenderer.invoke('tool:probeProject', payload),
  // A12：拖拽文件路径解析（Electron ≥32 移除 File.path，须在 preload 用 webUtils）
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  // A5：语音本地转写（whisper.cpp）
  transcribeVoice: (payload) => ipcRenderer.invoke('voice:transcribe', payload),
  // A12：粘贴/无路径文件落盘
  saveUpload: (payload) => ipcRenderer.invoke('files:saveUpload', payload),
  // 本地项目工作区（~/Documents/.MJCoder）
  getWorkspaceInfo: () => ipcRenderer.invoke('project:workspaceInfo'),
  createProject: (payload) => ipcRenderer.invoke('project:create', payload),
  // Skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  getSkill: (payload) => ipcRenderer.invoke('skills:get', payload),
  installEcosystemSkill: (payload) => ipcRenderer.invoke('skills:installEcosystem', payload),
  importSkillsFromDir: (payload) => ipcRenderer.invoke('skills:importFromDir', payload),
  // 插件市场（M6）
  marketRefresh: () => ipcRenderer.invoke('market:refresh'),
  marketSearch: (payload) => ipcRenderer.invoke('market:search', payload),
  // P0-S2 修复：字段白名单，不再原样透传整个 payload。
  // 事故背景：原实现 (payload) => invoke(..., payload) 把调用方传入的任何字段
  // 全部送进主进程，其中包括 allowUnsigned / allowUnsafeInjection 这类安全降级开关
  // —— 渲染层一旦有 XSS 即可关闭签名校验与提示注入扫描。
  // 现在只放行安装 Git 仓库所必需的三个字段，其余一律丢弃（纵深防御：主进程侧
  // market:installGit 也会再剥离一次，两层独立生效）。
  marketInstallGit: (payload) => ipcRenderer.invoke('market:installGit', {
    url: String(payload?.url || ''),
    ref: payload?.ref == null ? undefined : String(payload.ref),
  }),
  marketListInstalled: () => ipcRenderer.invoke('market:listInstalled'),
  marketInspect: (payload) => ipcRenderer.invoke('market:inspect', payload),
  marketSetEnabled: (payload) => ipcRenderer.invoke('market:setEnabled', payload),
  marketUninstall: (payload) => ipcRenderer.invoke('market:uninstall', payload),
  marketCheckPermission: (payload) => ipcRenderer.invoke('market:checkPermission', payload),
  // 协同（P4/P5）：主进程侧 Yjs 本地优先快照层
  collabOpen: (payload) => ipcRenderer.invoke('collab:open', payload),
  collabDocId: (payload) => ipcRenderer.invoke('collab:docId', payload),
  collabPersist: (payload) => ipcRenderer.invoke('collab:persist', payload),
  collabEncodePush: (payload) => ipcRenderer.invoke('collab:encodePush', payload),
  collabApplyUpdate: (payload) => ipcRenderer.invoke('collab:applyUpdate', payload),
  collabListLocal: () => ipcRenderer.invoke('collab:listLocal'),
  collabCloseAll: () => ipcRenderer.invoke('collab:closeAll'),
  // 生态资产目录（M7）：数字员工 / MCP 连接器 / Skill
  ecosystemSummary: () => ipcRenderer.invoke('ecosystem:summary'),
  ecosystemEmployees: (payload) => ipcRenderer.invoke('ecosystem:employees', payload),
  ecosystemConnectors: (payload) => ipcRenderer.invoke('ecosystem:connectors', payload),
  ecosystemSkills: () => ipcRenderer.invoke('ecosystem:skills'),
  // Updater
  checkUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
  // Local-first（离线模式）
  serverHealth: () => ipcRenderer.invoke('server:health'),
  localThreads: (payload) => ipcRenderer.invoke('local:threads/list', payload || {}),
  localCreateThread: (payload) => ipcRenderer.invoke('local:threads/create', payload),
  localSetThreadStatus: (payload) => ipcRenderer.invoke('local:threads/set-status', payload),
  localDeleteThread: (payload) => ipcRenderer.invoke('local:threads/delete', payload),
  // A1：重命名 / A3：归档恢复 / B1：归组
  localRenameThread: (payload) => ipcRenderer.invoke('local:threads/rename', payload),
  localArchivedThreads: () => ipcRenderer.invoke('local:threads/archived'),
  localRestoreThread: (payload) => ipcRenderer.invoke('local:threads/restore', payload),
  localPurgeThread: (payload) => ipcRenderer.invoke('local:threads/purge', payload),
  localSetThreadProject: (payload) => ipcRenderer.invoke('local:threads/set-project', payload),
  localMessages: (payload) => ipcRenderer.invoke('local:messages/list', payload),
  localAddMessage: (payload) => ipcRenderer.invoke('local:messages/add', payload),
  // /compact 落库：压缩摘要历史整体替换（P2-6 收口）
  localReplaceMessages: (payload) => ipcRenderer.invoke('local:messages/replace', payload),
  localProviders: () => ipcRenderer.invoke('local:providers/list'),
  localAddProvider: (payload) => ipcRenderer.invoke('local:providers/add', payload),
  localSetProviderModel: (payload) => ipcRenderer.invoke('local:providers/set-model', payload),
  // 多模型：模型条目增删
  localAddProviderModel: (payload) => ipcRenderer.invoke('local:providers/add-model', payload),
  localRemoveProviderModel: (payload) => ipcRenderer.invoke('local:providers/remove-model', payload),
  localDeleteProvider: (payload) => ipcRenderer.invoke('local:providers/delete', payload),
  // B2：供应商编辑与测试连接
  localUpdateProvider: (payload) => ipcRenderer.invoke('local:providers/update', payload),
  testConnection: (payload) => ipcRenderer.invoke('model:testConnection', payload),
  // B1：项目一等实体
  localProjects: () => ipcRenderer.invoke('local:projects/list'),
  localAddProject: (payload) => ipcRenderer.invoke('local:projects/add', payload),
  localRemoveProject: (payload) => ipcRenderer.invoke('local:projects/remove', payload),
  localRenameProject: (payload) => ipcRenderer.invoke('local:projects/rename', payload),
  // A7：审批规则管理
  listApprovalRules: () => ipcRenderer.invoke('approval:listRules'),
  deleteApprovalRule: (payload) => ipcRenderer.invoke('approval:deleteRule', payload),
  // A2：DiffReview 磁盘快照（放弃修改的撤销出口）
  createBackup: (payload) => ipcRenderer.invoke('backup:create', payload),
  restoreBackup: (payload) => ipcRenderer.invoke('backup:restore', payload),
  localGetPreference: (payload) => ipcRenderer.invoke('local:preferences/get', payload),
  localSetPreference: (payload) => ipcRenderer.invoke('local:preferences/set', payload),
  localAddMemory: (payload) => ipcRenderer.invoke('local:memories/add', payload),
  localListMemories: (payload) => ipcRenderer.invoke('local:memories/list', payload),
  // MCP
  mcpConnect: (payload) => ipcRenderer.invoke('mcp:connect', payload),
  mcpCallTool: (payload) => ipcRenderer.invoke('mcp:callTool', payload),
  mcpDisconnect: (payload) => ipcRenderer.invoke('mcp:disconnect', payload),
  mcpListServers: () => ipcRenderer.invoke('mcp:listServers'),
  mcpListTools: () => ipcRenderer.invoke('mcp:listTools'),
  mcpGetConfig: () => ipcRenderer.invoke('mcp:getConfig'),
  // 定时任务（桌面端本地调度器）
  scheduledList: () => ipcRenderer.invoke('scheduled:list'),
  scheduledSave: (payload) => ipcRenderer.invoke('scheduled:save', payload),
  scheduledDelete: (payload) => ipcRenderer.invoke('scheduled:delete', payload),
  scheduledRun: (payload) => ipcRenderer.invoke('scheduled:run', payload),
  scheduledRuns: (payload) => ipcRenderer.invoke('scheduled:runs', payload),
  scheduledSetModel: (payload) => ipcRenderer.invoke('scheduled:setModel', payload),
  onScheduledChanged: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('scheduled:changed', handler);
    return () => ipcRenderer.removeListener('scheduled:changed', handler);
  },
  // Approval
  onApprovalRequest: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('tool:approval-request', handler);
    return () => ipcRenderer.removeListener('tool:approval-request', handler);
  },
  // P0-2：决策负载携带 approvalId 回传（payload: { approvalId, decision }），
  // 主进程按 id 精确分发，并发审批不再串扰
  resolveApproval: (payload) => ipcRenderer.send('tool:approval-response', payload),
  // P0-4：主进程 Agent 运行通道——循环在主进程执行，渲染层发起/订阅/中止
  agentRun: (payload) => ipcRenderer.invoke('agent:run', payload),
  agentAbort: (runId) => ipcRenderer.invoke('agent:abort', { runId }),
  onAgentEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('agent:event', handler);
    return () => ipcRenderer.removeListener('agent:event', handler);
  },
  // P1：任务编排通道（拆解/执行/查询/取消/重试/并发配置 + 实时事件）
  tasksAutoRun: (payload) => ipcRenderer.invoke('tasks:autoRun', payload),
  tasksPlan: (payload) => ipcRenderer.invoke('tasks:plan', payload),
  tasksExecute: (groupId) => ipcRenderer.invoke('tasks:execute', { groupId }),
  tasksList: (opts) => ipcRenderer.invoke('tasks:list', opts),
  tasksGet: (groupId) => ipcRenderer.invoke('tasks:get', { groupId }),
  tasksCancel: (groupId) => ipcRenderer.invoke('tasks:cancel', { groupId }),
  tasksAbortTask: (groupId, taskId) => ipcRenderer.invoke('tasks:abortTask', { groupId, taskId }),
  tasksAbortGroup: (groupId) => ipcRenderer.invoke('tasks:abortGroup', { groupId }),
  memoryStats: () => ipcRenderer.invoke('memory:stats'),
  memoryBgTasks: (opts) => ipcRenderer.invoke('memory:bgTasks', opts),
  quotaSnapshot: () => ipcRenderer.invoke('quota:snapshot'),
  serverBase: (payload) => ipcRenderer.invoke('local:server/base', payload),
  // 网络插件发现（市场弹窗/调试用；对话内安装走 agent 工具通道）
  marketSearchNetwork: (payload) => ipcRenderer.invoke('market:searchNetwork', payload),
  // Phase 3-1：断点持久化（「继续」时取回并清除；保存由主进程在熔断时自动完成）
  checkpointGet: (threadKey) => ipcRenderer.invoke('checkpoint:get', threadKey),
  checkpointClear: (threadKey) => ipcRenderer.invoke('checkpoint:clear', threadKey),
  // Phase 3-4：token 仪表盘数据源（最近一次运行的逐轮用量快照）
  tokenState: () => ipcRenderer.invoke('agent:token/state'),
  tasksRetryTask: (groupId, taskId) => ipcRenderer.invoke('tasks:retryTask', { groupId, taskId }),
  tasksConfig: (payload) => ipcRenderer.invoke('tasks:config', payload),
  onTasksEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('tasks:event', handler);
    return () => ipcRenderer.removeListener('tasks:event', handler);
  },
  // Computer Use（M4-C）
  cuaStatus: () => ipcRenderer.invoke('cua:status'),
  cuaRun: (payload) => ipcRenderer.invoke('cua:run', payload),
  cuaStop: () => ipcRenderer.invoke('cua:stop'),
  onCuaEvent: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('cua:event', handler);
    return () => ipcRenderer.removeListener('cua:event', handler);
  },
  onCuaApprovalRequest: (cb) => {
    const handler = (_, d) => cb(d);
    ipcRenderer.on('cua:approval-request', handler);
    return () => ipcRenderer.removeListener('cua:approval-request', handler);
  },
  resolveCuaApproval: (decision) => ipcRenderer.send('cua:approval-response', decision),
});
