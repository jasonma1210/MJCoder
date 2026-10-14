// 协同主进程模块：本地 Y.Doc 持久化 + 与服务端 CRDT 增量同步
//
// 分工：
//   渲染层（lib/collab.js）持有 Y.Doc，负责本地 CRDT 读写与离线累积；
//   主进程（本模块）负责把本地 Y.Doc 落盘到 userData（离线可用、崩溃可恢复），
//   并提供与 API 服务端交换增量的能力。
//
// 边界：代码协同归 git，本模块只协同 AI 会话线程、任务看板、审批流。
const fs = require('fs');
const path = require('path');
const Y = require('yjs');

const DOC_TYPES = { THREAD: 'thread', BOARD: 'board', APPROVAL: 'approval' };

function makeDocId(type, entityId) {
  const t = String(type || '').trim().toLowerCase();
  if (!Object.values(DOC_TYPES).includes(t)) throw new Error(`未知的协同文档类型：${type}`);
  const id = String(entityId || '').trim();
  if (!id) throw new Error('协同文档实体 ID 不能为空');
  return `${t}:${id}`;
}

// 本地文档的磁盘路径：docId 中的冒号替换为下划线，避免非法文件名。
// 反向映射不可靠（实体 ID 本身可能含下划线），因此 docId 以快照内 meta 为准。
function docFileName(docId) {
  return `${String(docId).replace(/[:/\\]/g, '_')}.ydoc`;
}

class LocalCollab {
  constructor(dataDir) {
    this.dir = dataDir;
    this.docs = new Map(); // docId -> { doc, file, sv }
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  fileFor(docId) {
    return path.join(this.dir, docFileName(docId));
  }

  // 打开（或创建）本地文档：从磁盘快照恢复，UI 可立即离线使用
  open(docId) {
    const hit = this.docs.get(docId);
    if (hit) return hit;

    const doc = new Y.Doc();
    const m = doc.getMap('meta');
    m.set('docId', docId);
    m.set('type', String(docId).split(':')[0]);

    const file = this.fileFor(docId);
    if (fs.existsSync(file)) {
      try {
        Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(file)));
      } catch (err) {
        // 快照损坏时以空文档起步并保留损坏文件，便于人工排查，不静默吞掉
        console.error(`[collab] 本地快照读取失败，已保留原文件：${file}`, err.message);
      }
    }
    const entry = { doc, file, sv: Y.encodeStateVector(doc) };
    this.docs.set(docId, entry);
    return entry;
  }

  // 落盘：原子写（临时文件 + rename），崩溃不损坏既有快照
  persist(docId) {
    const entry = this.docs.get(docId);
    if (!entry || !entry.file) return { ok: false, error: '文档未打开' };
    const tmp = `${entry.file}.tmp`;
    try {
      fs.writeFileSync(tmp, Buffer.from(Y.encodeStateAsUpdate(entry.doc)));
      fs.renameSync(tmp, entry.file);
      // 落盘后光标前移到当前状态：下次只推增量
      entry.sv = Y.encodeStateVector(entry.doc);
      return { ok: true, bytes: fs.statSync(entry.file).size };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // 推给服务端的增量：以「服务端已确认持有的 stateVector」为基线。
  // 基线缺失（首次接触）时必须推全量，否则服务端缺少本端 struct，差量会被 Yjs 静默丢弃。
  encodePush(docId, serverStateVector) {
    const entry = this.docs.get(docId);
    if (!entry) throw new Error(`文档未打开：${docId}`);
    const base = serverStateVector ? new Uint8Array(Buffer.from(serverStateVector, 'base64')) : undefined;
    const update = Y.encodeStateAsUpdate(entry.doc, base);
    return Buffer.from(update).toString('base64');
  }

  // 应用服务端回包增量
  applyServerUpdate(docId, updateBase64) {
    const entry = this.docs.get(docId);
    if (!entry) throw new Error(`文档未打开：${docId}`);
    if (!updateBase64) return { applied: false };
    Y.applyUpdate(entry.doc, new Uint8Array(Buffer.from(updateBase64, 'base64')));
    this.persist(docId);
    return { applied: true, stateVector: Buffer.from(Y.encodeStateVector(entry.doc)).toString('base64') };
  }

  // 本地已有快照清单：docId 取自快照内 meta，避免由文件名反推
  listLocalDocs() {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    const out = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.ydoc')) continue;
      try {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(path.join(this.dir, f))));
        const docId = doc.getMap('meta').get('docId');
        if (docId) out.push({ docId, file: f, type: doc.getMap('meta').get('type') });
        doc.destroy();
      } catch (err) {
        console.error(`[collab] 本地快照解析失败，已跳过：${f}`, err.message);
      }
    }
    return out;
  }

  closeAll() {
    for (const docId of this.docs.keys()) this.persist(docId);
    this.docs.clear();
  }
}

module.exports = { LocalCollab, makeDocId, DOC_TYPES };