// 侧栏一级导航的选中态判定（纯函数，无 DOM/无 React 依赖）
//
// 背景（2026-10-18 用户实测）：「我选中的左侧菜单，虽然跳转的页面是对的，但是左侧的菜单
// 没有被选中」。真因两条，缺一都会复现：
//   ① 判据不互斥也不穷尽：此前只有「新建会话」传了 active，且写成 `!activeThread`。
//      定时任务页没有打开会话 → 该亮不亮；反之一旦有会话又可能两个一起亮。
//   ② 选中样式是 `bg-hover`，与 hover 同色 → 即使 active 传对了，视觉上仍等于没选中。
// 本函数只解决 ①；②由 Sidebar 的 NavItem 用 select-bg/select-fg 专用令牌解决。
//
// 说明：工作台（Dashboard）不以一级导航承载，故返回 ''（三项都不亮），
// 保持「它属于另一层入口」的语义；生态中心是覆盖在会话之上的弹层，打开时高亮其入口。
export type NavKey = 'new' | 'scheduled' | 'ecosystem' | 'teams' | '';

export interface NavViewState {
  /** 定时任务页是否在前台 */
  showScheduled: boolean;
  /** 工作台是否在前台 */
  showDashboard: boolean;
  /** 生态中心（弹层）是否打开 */
  showEcosystem: boolean;
  /** MJ 军团（团队编制页）是否在前台 */
  showTeams: boolean;
  /** 是否选中了某个会话 */
  hasActiveThread: boolean;
}

export function activeNavOf(view: NavViewState): NavKey {
  if (view.showScheduled) return 'scheduled';
  if (view.showEcosystem) return 'ecosystem';
  if (view.showTeams) return 'teams';
  if (view.showDashboard || view.hasActiveThread) return '';
  return 'new';
}
