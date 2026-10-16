import React from 'react';
import { tGlobal } from '../i18n';

// 渲染层崩溃兜底（M3-5）：捕获渲染异常，展示恢复界面而非白屏
// i18n：类组件无法用 hook，render 时经 tGlobal 求值（Provider 切换会同步 activeLocale）
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // 崩溃留痕（开发期控制台；主进程 crash.log 由 uncaughtException 通道负责）
    console.error('[crash] renderer error:', error.message, info?.componentStack);
    try {
      const crumbs = JSON.parse(localStorage.getItem('mj_crash_log') || '[]');
      crumbs.unshift({ at: new Date().toISOString(), message: String(error.message).slice(0, 300) });
      localStorage.setItem('mj_crash_log', JSON.stringify(crumbs.slice(0, 20)));
    } catch (e) { /* localStorage 异常时静默 */ }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen flex flex-col items-center justify-center bg-bg text-text px-8 text-center">
          <h1 className="text-2xl font-semibold mb-3">{tGlobal('errorBoundary.title')}</h1>
          <p className="text-text2 text-sm mb-2 max-w-md">{String(this.state.error.message || this.state.error).slice(0, 300)}</p>
          <p className="text-text2 text-xs mb-6">{tGlobal('errorBoundary.hint')}</p>
          <div className="flex gap-3">
            <button onClick={() => this.setState({ error: null })}
              className="border border-border rounded-lg px-4 py-2 text-sm hover:bg-hover">{tGlobal('errorBoundary.retry')}</button>
            <button onClick={() => window.location.reload()}
              className="bg-accent text-white rounded-lg px-4 py-2 text-sm">{tGlobal('errorBoundary.reload')}</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
