//
// M5 / T5-4：对话 `+` 菜单「军团」栏位 —— 团队选择面板（设计稿 §6 F1/F2 的实现落点）。
//
// 形态（2026-10-20 需求⑤：不再「两步表单」，改为一步选团队）：
//   · 列出全部未归档团队（军团全局可见）；每行显示 名称 + 信息描述 + 成员数；
//   · 点选即「选中该团队」——回填到输入框上方的团队名徽标（onSelectTeam），并关闭本面板；
//   · 用户随后在输入框写的内容，由 ChatArea 的 sendOrDispatch 自动派活给该团队
//     （主进程按「主管统筹 + 团队默认预算 + 全队成员」缺省派活）。
//
// 为什么去掉 本次任务目标/协作模式/预算上限/参与成员 四块表单：
//   这四项在派活时都有合理的缺省来源（目标=用户输入的那句话；模式=team.defaultMode；
//   预算=team.budget；成员=全队），暴露成必填表单只会把「说一句话就派活」变成「填四个表」。
//   缺省回落由主进程 teams:dispatch 承担（单一事实来源），渲染层不再各判一份。
//
// 纪律：
//   · 缺统筹：列表常驻只显示温和提示（leadMissing），不弹窗、不阻塞；真正的强校验在
//     发送派活时由 ChatArea / 主进程给出（服务端 code=LEAD_MISSING 是权威判据）。
//   · 文案一律走 i18n（零裸中文）；选中交互用 label + 单选控件，不新增裸 <button>。
import { useEffect, useState } from 'react';
import { IconUsers } from './icons';
import InlineAlert from './InlineAlert';
import { useI18n } from '../i18n';

interface Team {
  id: string;
  name: string;
  description?: string;
  archivedAt?: string | null;
  leadMissing?: boolean;
  memberCount?: number;
  members?: Array<{ id: string; enabled?: boolean }>;
}

export default function TeamDispatchPanel({
  onClose, activeTeamId = null, onSelectTeam,
}: {
  onClose?: () => void;
  activeTeamId?: string | null;
  onSelectTeam?: (team: Team) => void;
}) {
  const { t } = useI18n();
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  // 团队列表：只列未归档（归档团队派活必被服务端拒绝，不必让用户先看到再撞墙）
  useEffect(() => {
    let alive = true;
    (async () => {
      const api = window.mjcode;
      if (!api?.teamsList) { if (alive) { setLoading(false); setErr(t('teams.loadFailed')); } return; }
      try {
        const r = (await api.teamsList({})) as { ok?: boolean; teams?: Team[]; error?: string } | undefined;
        if (!alive) return;
        if (r?.ok) setTeams((r.teams || []).filter((x) => !x.archivedAt));
        else setErr(r?.error || t('teams.loadFailed'));
      } catch (e) {
        if (alive) setErr((e as Error).message || t('teams.loadFailed'));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [t]);

  // 选中团队：直接回填 + 关面板（不再有第二步表单）
  function pick(team: Team) {
    onSelectTeam?.(team);
    onClose?.();
  }

  return (
    <div className="max-h-80 overflow-y-auto">
      <p className="text-text2 text-caption px-3 py-2 leading-relaxed">{t('teams.dispatchPickHint')}</p>
      {loading && <p className="text-text2 text-xs px-3 py-3">{t('teams.loading')}</p>}
      {!loading && teams.length === 0 && (
        <p className="text-text2 text-xs px-3 py-4 leading-relaxed">{t('teams.dispatchNoTeams')}</p>
      )}
      {teams.map((x) => {
        const count = x.memberCount ?? (x.members || []).filter((m) => m.enabled !== false).length;
        return (
          <label key={x.id}
            className={`w-full flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-hover border-b border-border last:border-0 ${
              x.id === activeTeamId ? 'bg-accent-bg' : ''}`}>
            <input type="radio" name="mjcode-team-pick" className="sr-only"
              checked={x.id === activeTeamId} onChange={() => pick(x)} />
            <IconUsers size={14} className="text-text2 shrink-0 mt-1" />
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-xs truncate">{x.name}</span>
                {x.leadMissing && (
                  <span className="shrink-0 text-caption px-2 rounded bg-warn-bg text-warn">{t('teams.leadMissing')}</span>
                )}
              </span>
              <span className="block text-caption text-text2 truncate" title={x.description || ''}>
                {x.description || t('teams.noDescription')}
              </span>
              <span className="block text-caption text-text2 truncate">
                {t('teams.memberCount', { n: count })}
              </span>
            </span>
          </label>
        );
      })}
      {err && <div className="px-3 py-2"><InlineAlert type="error" onDismiss={() => setErr('')}>{err}</InlineAlert></div>}
    </div>
  );
}
