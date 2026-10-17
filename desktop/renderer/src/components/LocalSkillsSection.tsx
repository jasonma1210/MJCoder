// 生态中心「本地技能」区（统一入口重构 T3；设置页 skills tab 删除后唯一入口）
// 承接原 SettingsModal 技能 tab 两类内容：内置技能开关（BUILTIN_SKILLS）与
// 磁盘文件技能开关（~/.mjcode/skills，含「从文件夹导入」）。
// 启用语义（D4）：勾选 = 加入 App 的 enabledSkills（localStorage mj_enabled_skills），
// 取消 = 仅摘除启用态、保留磁盘 SKILL.md——非破坏可逆，重启用零成本。
import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import Switch from './ui/Switch';
import { IconChevronDown, IconUpload } from './icons';
import { BUILTIN_SKILLS } from '../lib/builtinSkills';
import { skillKeyIn, normSkillKey } from '../lib/skillKey';

// T3-2：内置技能清单已提取至 lib/builtinSkills.ts 共享（+ 菜单同源渲染，2026-10-16）

interface DiskSkill { dir: string; name?: string; description?: string }

interface Props {
  enabledSkills: string[];
  onSkillsChange: (next: string[]) => void;
}

export default function LocalSkillsSection({ enabledSkills, onSkillsChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const [diskSkills, setDiskSkills] = useState<DiskSkill[]>([]);
  const [msg, setMsg] = useState('');

  const refreshDisk = useCallback(async () => {
    try {
      const r = (await window.mjcode?.listSkills?.()) as { ok?: boolean; skills?: DiskSkill[] } | undefined;
      if (r?.ok) setDiskSkills(r.skills || []);
    } catch (e) { console.warn('[local-skills] listSkills failed:', e); }
  }, []);

  useEffect(() => { refreshDisk(); }, [refreshDisk]);

  function toggle(id: string, on: boolean) {
    onSkillsChange(on ? [...new Set([...enabledSkills, id])] : enabledSkills.filter((x) => x !== id));
  }

  async function importFromFolder() {
    setMsg('');
    try {
      const picked = (await window.mjcode?.pickDirectory?.()) as { ok?: boolean; path?: string } | undefined;
      if (!picked?.ok || !picked.path) return;
      const r = (await window.mjcode?.importSkillsFromDir?.({ dir: picked.path })) as
        { ok?: boolean; found?: number; installed?: string[]; failed?: string[]; error?: string } | undefined;
      if (r?.ok) {
        setMsg(t('localSkills.importSummary', { found: r.found || 0, installed: (r.installed || []).length })
          + ((r.failed || []).length ? t('localSkills.importFailedSuffix', { failed: r.failed!.length }) : ''));
        await refreshDisk();
      } else {
        setMsg(r?.error || t('localSkills.importFailed'));
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : t('localSkills.importFailed'));
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 px-4 py-3 text-left">
        <IconChevronDown size={13} className={`text-text2 transition-transform ${open ? '' : '-rotate-90'}`} />
        <span className="text-sm font-medium">{t('localSkills.title')}</span>
        {/* 2026-10-16（用户实测反馈「15/13」计数溢出）：enabledSkills 混存生态目录 id，
            直接取 length 会大于本地技能总数。计数改为「本地技能（内置+磁盘）中已启用的数量」。 */}
        <span className="text-xs text-text2">{t('localSkills.count', {
          enabled: BUILTIN_SKILLS.filter((s) => skillKeyIn(s.id, enabledSkills)).length
            + diskSkills.filter((s) => skillKeyIn(s.dir, enabledSkills) || skillKeyIn(s.name, enabledSkills)).length,
          total: BUILTIN_SKILLS.length + diskSkills.length,
        })}</span>
        <span className="flex-1" />
        <span onClick={(e) => { e.stopPropagation(); importFromFolder(); }}
          className="h-7 inline-flex items-center gap-1 px-2.5 rounded-lg border border-border text-xs text-text2 hover:text-text cursor-pointer shrink-0">
          <IconUpload size={12} /> {t('localSkills.importFromFolder')}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-3">
          {msg && <p className="text-xs text-text2 mb-2">{msg}</p>}
          {/* 内置技能 */}
          <p className="text-xs text-text2 mt-1 mb-1">{t('localSkills.builtinTitle')}</p>
          {BUILTIN_SKILLS.map((s) => {
            const on = skillKeyIn(s.id, enabledSkills); // 归一化匹配（code_review/code-review 等价）
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
                <div className="min-w-0">
                  <div className="text-xs font-medium truncate">{t(s.nameKey)}</div>
                  <div className="text-xs text-text2 truncate">{t(s.descKey)}</div>
                </div>
                <Switch checked={on} onChange={(next) => toggle(s.id, next)} label={t('settings.enableToggle', { name: t(s.nameKey) })} />
              </div>
            );
          })}
          {/* 文件技能（磁盘 SKILL.md） */}
          <p className="text-xs text-text2 mt-3 mb-1">{t('localSkills.fileTitle')}</p>
          {diskSkills.length === 0 ? (
            <p className="text-xs text-text2 py-2 leading-relaxed">
              {t('localSkills.noFiles')}
            </p>
          ) : diskSkills.map((s) => {
            const on = skillKeyIn(s.dir, enabledSkills) || skillKeyIn(s.name, enabledSkills); // 归一化匹配
            return (
              <div key={s.dir} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
                <div className="min-w-0">
                  <div className="text-xs font-mono truncate">{s.name || s.dir}</div>
                  {s.description && <div className="text-xs text-text2 truncate">{s.description}</div>}
                </div>
                <Switch checked={on} onChange={(next) => toggle(s.dir, next)} label={t('settings.enableToggle', { name: s.name || s.dir })} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
