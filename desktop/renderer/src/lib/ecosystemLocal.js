// 生态资产本地下载清单（E1 下载模型）
// 语义：生态中心只负责「下载」；下载后的数字员工 / 连接器进入本清单，
// 会话输入框「+」菜单只展示清单内（已下载）或内置的资产。
// 技能例外：走主进程 skills:installEcosystem 物化为 SKILL.md，天然在 listSkills 中可见。
//
// TODO(backend)：后期目录与下载清单统一迁移到自有后端 / userData 持久层，
// 此处集中存取正好作为切换点（调用方无需改动）。

const EMP_KEY = 'mj_downloaded_employees';
const CON_KEY = 'mj_downloaded_connectors';

function readList(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : [];
  } catch (e) {
    console.warn('[ecosystemLocal] 下载清单解析失败:', key);
    return [];
  }
}

function writeList(key, list) {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch (e) { console.warn('[ecosystemLocal] 下载清单写入失败:', key, e); }
}

// ── 数字员工 ──
export function listDownloadedEmployees() {
  return readList(EMP_KEY);
}

export function isEmployeeDownloaded(id) {
  return listDownloadedEmployees().some((e) => String(e.id) === String(id));
}

export function downloadEmployee(employee) {
  if (!employee || employee.id == null) return;
  const list = listDownloadedEmployees();
  if (!list.some((e) => String(e.id) === String(employee.id))) {
    list.push(employee);
    writeList(EMP_KEY, list);
  }
}

// ── 连接器 ──
export function listDownloadedConnectors() {
  return readList(CON_KEY);
}

export function isConnectorDownloaded(id) {
  return listDownloadedConnectors().some((c) => String(c.id) === String(id));
}

export function downloadConnector(connector) {
  if (!connector || connector.id == null) return;
  const list = listDownloadedConnectors();
  if (!list.some((c) => String(c.id) === String(connector.id))) {
    list.push(connector);
    writeList(CON_KEY, list);
  }
}
