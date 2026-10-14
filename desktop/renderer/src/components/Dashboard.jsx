import { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { IconDownload, IconMail, IconMessage, IconUpload } from './icons';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.dashboard()
      .then(setStats)
      .catch((err) => {
        console.warn('[dashboard] 加载失败:', err);
        setError('数据加载失败，请稍后重试');
      });
  }, []);

  if (error) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">数据概览</h2>
        <p className="text-text2 text-sm">{error}</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="p-6">
        <h2 className="text-lg font-semibold mb-4">数据概览</h2>
        <div className="grid grid-cols-4 gap-4 mb-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface rounded-lg border border-border p-4 animate-pulse">
              <div className="h-8 bg-hover rounded mb-2" />
              <div className="h-3 bg-hover rounded w-2/3" />
            </div>
          ))}
        </div>
        <p className="text-text2 text-sm">加载中...</p>
      </div>
    );
  }

  const totalTokens = (stats.tokens_input || 0) + (stats.tokens_output || 0);
  const dist = stats.model_distribution || [];
  const maxTokens = Math.max(...dist.map(d => d.tokens || 0), 1);
  const activity = stats.recent_activity || [];
  const weekly = stats.weekly_threads || [];

  // D3：最近 7 天固定补零（按 MM-DD 对齐，缺的天数填 0，横轴不再忽长忽短）
  const activityByDay = new Map(activity.map((x) => [String(x.day || '').slice(5), x.count || 0]));
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() - (6 - i) * 86400000);
    const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return { day: key, count: activityByDay.get(key) || 0 };
  });
  const activityMax = Math.max(...last7Days.map((x) => x.count), 1);

  return (
    <div className="p-6 overflow-y-auto">
      <h2 className="text-lg font-semibold mb-1">数据概览</h2>
      <p className="text-text2 text-xs mb-4">累计消耗 {fmt(totalTokens)} tokens</p>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="对话数" value={fmt(stats.threads || 0)} icon={<IconMessage size={20} />} />
        <StatCard label="消息数" value={fmt(stats.messages || 0)} icon={<IconMail size={20} />} />
        <StatCard label="输入 Tokens" value={fmt(stats.tokens_input || 0)} icon={<IconDownload size={20} />} />
        <StatCard label="输出 Tokens" value={fmt(stats.tokens_output || 0)} icon={<IconUpload size={20} />} />
      </div>

      {/* 模型使用分布 */}
      <div className="bg-surface rounded-lg border border-border p-4 mb-4">
        <h3 className="text-sm font-medium mb-3">模型使用分布</h3>
        {dist.length === 0 ? (
          <p className="text-text2 text-sm">暂无数据</p>
        ) : (
          dist.map((d, i) => (
            <div key={i} className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span>{d.model}</span>
                <span className="text-text2">{d.messages} 条 · {fmt(d.tokens)} tokens</span>
              </div>
              <div className="h-2 bg-bg rounded-full overflow-hidden">
                <div className="h-full bg-accent rounded-full" style={{ width: `${((d.tokens || 0) / maxTokens) * 100}%` }} />
              </div>
            </div>
          ))
        )}
      </div>

      {/* 最近 7 天活跃 */}
      <div className="bg-surface rounded-lg border border-border p-4 mb-4">
        <h3 className="text-sm font-medium mb-3">最近 7 天消息量</h3>
        {activity.length === 0 ? (
          <p className="text-text2 text-sm">近 7 天暂无消息</p>
        ) : (
          <div className="flex items-end gap-2 h-24">
            {last7Days.map((d) => (
              <div key={d.day} className="flex-1 flex flex-col items-center">
                <div className="w-full bg-accent rounded-t" style={{ height: `${(d.count / activityMax) * 80}px` }} />
                <span className="text-xs text-text2 mt-1">{d.day}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 近 8 周对话趋势 —— D1：数据源为空时整卡隐藏（本地模式此前永远「暂无数据」，属假功能） */}
      {weekly.length > 0 && (
        <div className="bg-surface rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-3">近 8 周新增对话</h3>
          <div className="flex items-end gap-2 h-20">
            {weekly.slice().reverse().map((w, i) => {
              const max = Math.max(...weekly.map(x => x.count || 0), 1);
              return (
                <div key={i} className="flex-1 flex flex-col items-center" title={`${w.week}：${w.count} 个对话`}>
                  <div className="w-full bg-accent/70 rounded-t" style={{ height: `${((w.count || 0) / max) * 64}px` }} />
                  <span className="text-xs text-text2 mt-1">{w.week.slice(5)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, icon }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className="text-accent mb-1">{icon}</div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-text2">{label}</div>
    </div>
  );
}

function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
