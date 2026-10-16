import { useState, useEffect } from 'react';
import { IconFile, IconFolder } from './icons';
import { useI18n } from '../i18n';

const IGNORED = new Set(['node_modules', '.git', 'dist', '.vite', 'release']);

// R3：忽略清单 = 内置默认 + 项目根 .gitignore 的顶层条目合并
// （此前硬编码 5 项，Python/Next 等项目的 .venv/__pycache__/.next 全部漏进文件树）
function parseGitignore(content) {
  const set = new Set();
  for (const raw of String(content || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // 取反规则不处理
    // 取条目末段目录/文件名做名字级匹配（不做 glob 语义，够覆盖常见场景）
    const name = line.replace(/\/+$/, '').split('/').pop();
    if (name && name !== '*' && name !== '.' && name !== '..') set.add(name);
  }
  return set;
}

// 受控文件树：root 由外部项目状态驱动；文件点击回调 onOpenFile（缺省回落为插入路径引用）
export default function FileTree({ root, onOpenFile }) {
  const { t } = useI18n();
  const [tree, setTree] = useState({});
  const [selected, setSelected] = useState(null);
  const [ignoredNames, setIgnoredNames] = useState(() => new Set(IGNORED));

  async function loadDir(p) {
    try {
      const entries = await window.mjcode.listDir({ path: p });
      setTree((prev) => ({ ...prev, [p]: entries }));
    } catch (err) {
      console.warn('[fileTree] list dir failed:', p, err);
    }
  }

  // 加载项目根 .gitignore 并合并进忽略清单
  useEffect(() => {
    if (!root) return;
    setIgnoredNames(new Set(IGNORED));
    window.mjcode.readFile?.({ path: `${root}/.gitignore`, offset: 0, limit: 500 })
      .then((r) => {
        if (r && typeof r.content === 'string') setIgnoredNames((prev) => new Set([...prev, ...parseGitignore(r.content)]));
      })
      .catch(() => { /* 无 .gitignore 属正常态 */ });
  }, [root]);

  useEffect(() => {
    if (root) { setTree({}); setSelected(null); loadDir(root); }
  }, [root]);

  if (!root) return null;
  const isIgnored = (name) => ignoredNames.has(name);
  const entries = (tree[root] || []).filter((e) => !isIgnored(e.name));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 py-1 text-xs">
      <DirNode path={root} entries={entries} depth={0} tree={tree} loadDir={loadDir} onSelect={setSelected} onOpenFile={onOpenFile} isIgnored={isIgnored} />
      {selected && !onOpenFile && (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent('mjcode:insert-path', { detail: selected }))}
          className="w-full text-left px-1 py-1 text-accent truncate hover:underline flex items-center gap-1"
          title={t('fileTree.insertHint')}
        >
          <IconFile size={12} /> {selected.split('/').pop()}
        </button>
      )}
    </div>
  );
}

function DirNode({ path: dir, entries, depth, tree, loadDir, onSelect, onOpenFile, isIgnored }) {
  const [open, setOpen] = useState(depth === 0);
  return (
    <div>
      {entries.map((e) => {
        const full = dir.endsWith('/') ? dir + e.name : dir + '/' + e.name;
        return (
          <div key={full}>
            <div
              style={{ paddingLeft: depth * 12 + 4 }}
              className="py-1 cursor-pointer hover:bg-hover rounded truncate flex items-center gap-1"
              onClick={() => {
                if (e.isDir) { setOpen(!open); if (!open) loadDir(full); }
                else if (onOpenFile) onOpenFile(full);
                else onSelect(full);
              }}
            >
              {e.isDir ? <IconFolder size={12} /> : <IconFile size={12} />} {e.name}
            </div>
            {e.isDir && open && tree[full] && (
              <DirNode path={full} entries={tree[full].filter((x) => !isIgnored(x.name))} depth={depth + 1} tree={tree} loadDir={loadDir} onSelect={onSelect} onOpenFile={onOpenFile} isIgnored={isIgnored} />
            )}
          </div>
        );
      })}
    </div>
  );
}
