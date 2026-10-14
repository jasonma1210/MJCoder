// 协同 CRDT 测试：纯 Yjs + 内存存储，不依赖 PostgreSQL
// 运行：node test/collab.test.js
const crdt = require('../src/collab/crdt');
const { DocStore, MemoryStore } = require('../src/collab/docStore');
const { CollabSync } = require('../src/collab/sync');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// 两台「设备」：各自独立 Y.Doc，离线各自累积 update，联网后双向交换合并
function makeDevice() {
  const docId = crdt.makeDocId(crdt.DOC_TYPES.THREAD, 'thread-1');
  return { docId, doc: crdt.createDoc(docId) };
}

// 联网合并：把一端自 stateVector 之后的增量灌进另一端
function merge(target, source) {
  const diff = crdt.encodeUpdate(source.doc);
  crdt.applyUpdate(target.doc, diff);
  crdt.reconcile(target.doc);
}

(async () => {
  try {
    // ── 场景一：两台设备离线各写消息，联网后无损合并（验收核心）──
    {
      const a = makeDevice();
      const b = makeDevice();
      // 离线：设备 A 写两条，设备 B 写两条，双方互不可见
      crdt.appendMessage(a.doc, { id: 'm-a1', role: 'user', text: 'A 的第一条', actor: '设备A', ts: 1000 });
      crdt.appendMessage(a.doc, { id: 'm-a2', role: 'assistant', text: 'A 的第二条', actor: '设备A', ts: 1001 });
      crdt.appendMessage(b.doc, { id: 'm-b1', role: 'user', text: 'B 的第一条', actor: '设备B', ts: 1002 });
      crdt.appendMessage(b.doc, { id: 'm-b2', role: 'assistant', text: 'B 的第二条', actor: '设备B', ts: 1003 });

      merge(a, b);
      merge(b, a);

      const la = crdt.listMessages(a.doc);
      const lb = crdt.listMessages(b.doc);
      const idsA = la.map(m => m.id).sort();
      const idsB = lb.map(m => m.id).sort();
      check('1.1 合并后设备 A 看到四条消息', la.length === 4, `实际 ${la.length} 条`);
      check('1.2 合并后设备 B 看到四条消息', lb.length === 4, `实际 ${lb.length} 条`);
      check('1.3 双方消息 ID 集合一致（收敛）', JSON.stringify(idsA) === JSON.stringify(idsB), idsA.join(','));
      check('1.4 A 离线期间的消息未丢失', idsA.includes('m-a1') && idsA.includes('m-a2'));
      check('1.5 B 离线期间的消息未丢失', idsA.includes('m-b1') && idsA.includes('m-b2'));
      check('1.6 消息正文无损', la.find(m => m.id === 'm-b1').text === 'B 的第一条');
      check('1.7 消息按 ts 稳定排序', la.map(m => m.id).join(',') === 'm-a1,m-a2,m-b1,m-b2');
      check('1.8 合并后无消息残留 deleted 标记', la.every(m => m.deleted === false));
      // 幂等：同一份增量重复合并不产生重复消息
      merge(a, b);
      check('1.9 重复合并同一增量不产生重复消息', crdt.listMessages(a.doc).length === 4);
    }

    // ── 场景二：同一消息并发编辑 → CRDT 自动合并，不重复不丢失 ──
    {
      const a = makeDevice();
      const b = makeDevice();
      crdt.appendMessage(a.doc, { id: 'm-1', role: 'user', text: '初始内容', actor: '设备A', ts: 2000 });
      merge(b, a); // 建立共同基线

      // 并发：两端同时在同一条消息尾部追加
      crdt.editMessageText(a.doc, 'm-1', ' A补充');
      crdt.editMessageText(b.doc, 'm-1', ' B补充');

      merge(a, b);
      merge(b, a);

      const ta = crdt.listMessages(a.doc).find(m => m.id === 'm-1').text;
      const tb = crdt.listMessages(b.doc).find(m => m.id === 'm-1').text;
      check('2.1 并发编辑后两端正文一致', ta === tb, `A=${ta} / B=${tb}`);
      check('2.2 双方编辑内容都在（无丢失）', ta.includes('A补充') && ta.includes('B补充'), ta);
      check('2.3 原始内容未被破坏', ta.includes('初始内容'));
      check('2.4 消息条数不变（无重复）', crdt.listMessages(a.doc).length === 1);
      check('2.5 无字符级重复叠加', ta.split('A补充').length === 2);

      // 并发整段替换：Y.Text 的 delete+insert 仍可交换合并
      crdt.replaceMessageText(a.doc, 'm-1', 'A 重写全文');
      crdt.replaceMessageText(b.doc, 'm-1', 'B 重写全文');
      merge(a, b);
      merge(b, a);
      const ra = crdt.listMessages(a.doc).find(m => m.id === 'm-1').text;
      const rb = crdt.listMessages(b.doc).find(m => m.id === 'm-1').text;
      check('2.6 并发替换后两端仍一致', ra === rb, `A=${ra} / B=${rb}`);
      check('2.7 并发替换不产生空消息', ra.length > 0);
    }

    // ── 场景三：状态字段并发改 → 业务层 LWW 生效（后写胜出）──
    {
      const docId = crdt.makeDocId(crdt.DOC_TYPES.BOARD, 'board-1');
      const a = crdt.createDoc(docId);
      const b = crdt.createDoc(docId);
      crdt.upsertCard(a, { id: 'card-1', title: '实现登录页', actor: '设备A', ts: 3000 });
      crdt.applyUpdate(b, crdt.encodeUpdate(a)); // 共同基线

      // 并发：A 与 B 同时移动同一张卡片到不同列，A 先写、B 后写
      crdt.moveCard(a, 'card-1', { column: 'doing', position: 1, actor: '设备A', ts: 3001 });
      crdt.moveCard(b, 'card-1', { column: 'done', position: 2, actor: '设备B', ts: 3002 });

      crdt.applyUpdate(a, crdt.encodeUpdate(b));
      crdt.applyUpdate(b, crdt.encodeUpdate(a));
      crdt.reconcile(a);
      crdt.reconcile(b);

      const ca = crdt.listCards(a)[0];
      const cb = crdt.listCards(b)[0];
      check('3.1 看板卡片 LWW 后写者胜出（A 端为 done）', ca.column === 'done', `column=${ca.column}`);
      check('3.2 两端 LWW 裁决一致', ca.column === cb.column, `A=${ca.column} / B=${cb.column}`);
      check('3.3 卡片位置取后写值', ca.position === 2, `position=${ca.position}`);
      check('3.4 卡片标题未被移动操作覆盖', ca.title === '实现登录页');

      // ts 相同时用 actor 字典序兜底，保证跨端确定性
      const c = crdt.createDoc(docId);
      crdt.applyUpdate(c, crdt.encodeUpdate(a));
      crdt.writeState(c, 'card:card-1', { column: 'review', position: 3 }, { actor: '设备C', ts: 3002 });
      crdt.applyUpdate(a, crdt.encodeUpdate(c));
      crdt.reconcile(a);
      check('3.5 ts 相同由 actor 字典序裁决，结果确定', crdt.listCards(a)[0].column === 'review', crdt.listCards(a)[0].column);

      // 三端并发写不同字段互不干扰
      const d = crdt.createDoc(docId);
      crdt.applyUpdate(d, crdt.encodeUpdate(a));
      crdt.writeState(d, 'card:card-2', { column: 'todo', position: 9 }, { actor: '设备D', ts: 3100 });
      crdt.applyUpdate(a, crdt.encodeUpdate(d));
      crdt.reconcile(a);
      check('3.6 不同字段并发写互不覆盖', crdt.getState(a, 'card:card-2').column === 'todo');
      check('3.7 原字段仍保留', crdt.getState(a, 'card:card-1').column === 'review');
    }

    // ── 场景四：审批幂等 —— 两个相同 approval-id 并发提交只记一次 ──
    {
      const docId = crdt.makeDocId(crdt.DOC_TYPES.APPROVAL, 'approval-1');
      const a = crdt.createDoc(docId);
      const b = crdt.createDoc(docId);

      // A 发起审批（发起动作本身也是一条审批记录）
      const start = crdt.recordApproval(a, {
        approvalId: 'ap-1', instanceId: 'run-77', decision: 'note', note: '申请执行删除旧构建产物', actor: '设备A', ts: 4000,
      });
      check('4.1 首次提交审批返回 applied=true', start.applied === true && start.deduped === false);

      // A 与 B 同时对同一 approval-id 提交 approve（模拟两人同时点批准）
      crdt.recordApproval(a, { approvalId: 'ap-1', decision: 'approve', note: '同意', actor: '设备A', ts: 4001 });
      crdt.recordApproval(b, { approvalId: 'ap-1', decision: 'approve', note: '同意', actor: '设备B', ts: 4002 });

      crdt.applyUpdate(a, crdt.encodeUpdate(b));
      crdt.applyUpdate(b, crdt.encodeUpdate(a));
      crdt.reconcile(a);
      crdt.reconcile(b);

      const countA = crdt.approvalCount(a, 'ap-1');
      const countB = crdt.approvalCount(b, 'ap-1');
      check('4.2 两人同时批准同一实例只记一次（A 端）', countA === 1, `count=${countA}`);
      check('4.3 两人同时批准同一实例只记一次（B 端）', countB === 1, `count=${countB}`);
      check('4.4 幂等索引中 approval-id 唯一', crdt.listApprovals(a)[0].approvalId === 'ap-1');
      check('4.5 审批状态归约为已批准', crdt.approvalStatus(a, 'ap-1') === 'approved', crdt.approvalStatus(a, 'ap-1'));

      // 同端重复提交同一动作：本地即拦截
      const again = crdt.recordApproval(a, { approvalId: 'ap-1', decision: 'approve', note: '再点一次', actor: '设备A', ts: 4003 });
      check('4.6 同端重复提交被幂等去重', again.deduped === true && again.applied === false);
      check('4.7 重复提交未改变既有审批动作', crdt.listApprovals(a)[0].decision === 'approve');
      check('4.8 审批动作幂等索引按 approvalId#decision 建键', crdt.approvalActionKey('ap-1', 'approve') === 'ap-1#approve');

      // 不同 approval-id 是不同审批，互不影响
      crdt.recordApproval(a, { approvalId: 'ap-2', instanceId: 'run-78', decision: 'deny', note: '需要补单测', actor: '设备A', ts: 4004 });
      crdt.applyUpdate(b, crdt.encodeUpdate(a));
      crdt.reconcile(b);
      check('4.9 不同 approval-id 各自独立计数', crdt.approvalCount(b) === 2, `count=${crdt.approvalCount(b)}`);
      check('4.10 驳回的审批状态为已拒绝', crdt.approvalStatus(b, 'ap-2') === 'denied', crdt.approvalStatus(b, 'ap-2'));

      // 非法审批动作被拒
      let caught = null;
      try { crdt.recordApproval(a, { approvalId: 'ap-3', decision: 'abort', actor: '设备A' }); } catch (err) { caught = err; }
      check('4.11 非法审批动作被拒', !!caught && caught.message.includes('审批动作非法'), caught && caught.message);
      check('4.12 非法动作未写入审批列表', crdt.approvalCount(a, 'ap-3') === 0);
    }

    // ── 场景五：tombstone —— 删除与编辑冲突时删除不复活 ──
    {
      const a = makeDevice();
      const b = makeDevice();
      crdt.appendMessage(a.doc, { id: 'm-del', role: 'user', text: '待删除的消息', actor: '设备A', ts: 5000 });
      crdt.appendMessage(a.doc, { id: 'm-keep', role: 'user', text: '保留的消息', actor: '设备A', ts: 5001 });
      merge(b, a); // 建立共同基线

      // 并发：A 删除 m-del，B 同时在编辑 m-del
      const del = crdt.deleteMessage(a.doc, 'm-del', { actor: '设备A', ts: 5002, reason: '误发' });
      check('5.1 删除写入成功', del.ok === true);
      const edited = crdt.editMessageText(b.doc, 'm-del', 'B 在删除期间补充');
      check('5.2 删除前 B 的编辑成功（离线端不知情）', edited.ok === true);

      // 联网合并
      merge(a, b);
      merge(b, a);

      const ma = crdt.listMessages(a.doc).find(m => m.id === 'm-del');
      check('5.3 合并后删除不被复活', ma && ma.deleted === true);
      check('5.4 活消息列表已过滤该消息', !crdt.listLiveMessages(a.doc).some(m => m.id === 'm-del'));
      check('5.5 墓碑记录存在且带原因', crdt.listTombstones(a.doc).some(t => t.entityId === 'm-del' && t.reason === '误发'));
      check('5.6 B 端合并结果同样是删除态', crdt.listMessages(b.doc).find(m => m.id === 'm-del').deleted === true);

      // 墓碑单调：对已删除消息再次删除不覆盖原墓碑
      const again = crdt.deleteMessage(a.doc, 'm-del', { actor: '设备C', ts: 5003 });
      check('5.7 墓碑不重复写入', again.ok === false && again.error.includes('墓碑已存在'));
      const tomb = crdt.listTombstones(a.doc).filter(t => t.entityId === 'm-del');
      check('5.8 墓碑保持单条', tomb.length === 1);

      // 对已删除消息的编辑被拒（防止复活通道）
      const late = crdt.editMessageText(a.doc, 'm-del', '试图复活');
      check('5.9 对已删除消息的编辑被拒', late.ok === false && late.error.includes('已删除'), late.error);
      check('5.10 未删除消息不受影响', crdt.listLiveMessages(a.doc).some(m => m.id === 'm-keep'));
    }

    // ── 场景六：DocStore 持久化与读回 ──
    {
      const store = new MemoryStore();
      const docStore = new DocStore(store);
      const sync = new CollabSync(docStore);
      const docId = crdt.makeDocId(crdt.DOC_TYPES.THREAD, 'thread-persist');

      await sync.appendMessage(docId, { id: 'p1', role: 'user', text: '落库消息一', actor: '用户甲', ts: 6000 });
      await sync.appendMessage(docId, { id: 'p2', role: 'assistant', text: '落库消息二', actor: '用户甲', ts: 6001 });

      // 新进程视角：清空内存缓存，仅从持久层重建
      docStore.clearCache();
      const rebuilt = await new DocStore(store).open(docId, crdt.DOC_TYPES.THREAD);
      const msgs = crdt.listMessages(rebuilt.doc);
      check('6.1 快照持久化后可读回消息', msgs.length === 2, `实际 ${msgs.length} 条`);
      check('6.2 读回的消息正文正确', msgs[0].text === '落库消息一');
      check('6.3 读回的 doc 类型正确', crdt.meta(rebuilt.doc).type === crdt.DOC_TYPES.THREAD);

      // 推送增量后再次冷启动，增量日志可重放
      const doc2 = crdt.createDoc(docId);
      crdt.applyUpdate(doc2, rebuilt.seq === 0 ? crdt.encodeUpdate(rebuilt.doc) : crdt.encodeUpdate(rebuilt.doc));
      crdt.appendMessage(doc2, { id: 'p3', role: 'user', text: '离线后新增', actor: '用户乙', ts: 6002 });
      await sync.push(docId, crdt.DOC_TYPES.THREAD, [crdt.encodeUpdate(doc2)], '用户乙');

      docStore.clearCache();
      const after = await new DocStore(store).open(docId, crdt.DOC_TYPES.THREAD);
      check('6.4 增量日志重放后消息齐全', crdt.listMessages(after.doc).length === 3, `实际 ${crdt.listMessages(after.doc).length} 条`);

      // seq 持续推进
      const seqBefore = after.seq;
      await sync.appendMessage(docId, { id: 'p4', role: 'user', text: '再一条', actor: '用户甲', ts: 6003 });
      docStore.clearCache();
      const seqAfter = (await new DocStore(store).open(docId, crdt.DOC_TYPES.THREAD)).seq;
      check('6.5 快照写入后 seq 不回退', seqAfter >= seqBefore, `${seqBefore} -> ${seqAfter}`);

      // pull 按 stateVector 只回增量
      const client = crdt.createDoc(docId);
      const pulled = await sync.pull(docId, crdt.DOC_TYPES.THREAD, crdt.toBase64(crdt.encodeStateVector(client)));
      crdt.applyUpdate(client, crdt.fromBase64(pulled.update));
      check('6.6 pull 后客户端与服务端消息一致', crdt.listMessages(client).length === crdt.listMessages(after.doc).length + 1);
      check('6.7 pull 返回 stateVector 供后续增量同步', typeof pulled.stateVector === 'string' && pulled.stateVector.length > 0);

      // 压缩后仍可完整恢复
      await docStore.compact(docId, crdt.DOC_TYPES.THREAD);
      docStore.clearCache();
      const compacted = await new DocStore(store).open(docId, crdt.DOC_TYPES.THREAD);
      check('6.8 压缩后快照可完整恢复', crdt.listMessages(compacted.doc).length === 4, `实际 ${crdt.listMessages(compacted.doc).length} 条`);
    }

    // ── 场景七：端到端同步（两台设备离线写入 → 服务端中转 → 双方收敛）──
    {
      const store = new MemoryStore();
      const serverStore = new DocStore(store);
      const server = new CollabSync(serverStore);
      const docId = crdt.makeDocId(crdt.DOC_TYPES.THREAD, 'thread-e2e');

      const devA = crdt.createDoc(docId);
      const devB = crdt.createDoc(docId);

      // 同步光标：记录「服务端已确认持有的 stateVector」。
      // 首次接触光标为空 → 推全量（服务端缺少本端 struct 时差量会被 Yjs 静默丢弃）；
      // 收到回包 apply 后前移光标，之后才推差量。这是 y-protocols 的固有约束。
      const curA = crdt.createSyncCursor();
      const curB = crdt.createSyncCursor();

      // 两台设备离线各写
      crdt.appendMessage(devA, { id: 'e-a', role: 'user', text: 'A 离线写', actor: '甲', ts: 7000 });
      crdt.appendMessage(devB, { id: 'e-b', role: 'user', text: 'B 离线写', actor: '乙', ts: 7001 });

      // A 先上线
      const rA = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devA, curA))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devA)), actor: '甲',
      });
      crdt.applyUpdate(devA, crdt.fromBase64(rA.update));
      crdt.advanceCursor(curA, rA.stateVector);
      check('7.1 A 推增量后服务端已收到 A 的消息', rA.view.messages.some(m => m.id === 'e-a'));

      // B 后上线：推全量 + 拉差量（此时服务端已含 A 的消息）
      const rB = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devB, curB))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devB)), actor: '乙',
      });
      crdt.applyUpdate(devB, crdt.fromBase64(rB.update));
      crdt.advanceCursor(curB, rB.stateVector);
      check('7.2 B 联网后同时看到 A 与 B 的消息', rB.view.messages.length === 2, `实际 ${rB.view.messages.length} 条`);

      // A 再次同步补齐 B 的消息
      const rA2 = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devA, curA))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devA)), actor: '甲',
      });
      crdt.applyUpdate(devA, crdt.fromBase64(rA2.update));
      crdt.advanceCursor(curA, rA2.stateVector);
      check('7.3 A 二次同步后两条消息都在', crdt.listMessages(devA).length === 2);
      check('7.4 A 与服务端视图完全一致',
        JSON.stringify(crdt.listMessages(devA).map(m => m.id).sort()) === JSON.stringify(rA2.view.messages.map(m => m.id).sort()));
      check('7.5 B 与服务端视图完全一致',
        JSON.stringify(crdt.listMessages(devB).map(m => m.id).sort()) === JSON.stringify(rB.view.messages.map(m => m.id).sort()));

      // 重复同步幂等：基于光标无新内容时不产生重复消息
      const rA3 = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devA, curA))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devA)), actor: '甲',
      });
      check('7.6 无新内容时重复同步不产生重复消息', rA3.view.messages.length === 2, `实际 ${rA3.view.messages.length} 条`);

      // 断线重连：客户端基于旧光标补推差量仍能合并
      crdt.appendMessage(devA, { id: 'e-a2', role: 'assistant', text: 'A 断线期间写', actor: '甲', ts: 7003 });
      const rA4 = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devA, curA))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devA)), actor: '甲',
      });
      crdt.advanceCursor(curA, rA4.stateVector);
      check('7.7 断线重连补推差量成功合并', rA4.view.messages.some(m => m.id === 'e-a2'), `实际 ${rA4.view.messages.length} 条`);
      check('7.8 断线重连未丢失既有消息', rA4.view.messages.length === 3, `实际 ${rA4.view.messages.length} 条`);

      // 全新第三端接入：首次推全量后可看到全部历史
      const devC = crdt.createDoc(docId);
      const curC = crdt.createSyncCursor();
      const rC = await server.sync(docId, crdt.DOC_TYPES.THREAD, {
        updates: [crdt.toBase64(crdt.encodePushUpdate(devC, curC))],
        stateVector: crdt.toBase64(crdt.encodeStateVector(devC)), actor: '丙',
      });
      crdt.applyUpdate(devC, crdt.fromBase64(rC.update));
      crdt.advanceCursor(curC, rC.stateVector);
      check('7.9 全新端接入后可看到全部历史消息', crdt.listMessages(devC).length === 3, `实际 ${crdt.listMessages(devC).length} 条`);
    }

    // ── 场景八：团队空间看板与共享审批全流程（A 发起 → B 批准）──
    {
      const store = new MemoryStore();
      const server = new CollabSync(new DocStore(store));
      const boardId = crdt.makeDocId(crdt.DOC_TYPES.BOARD, 'board-team');
      const approvalId = crdt.makeDocId(crdt.DOC_TYPES.APPROVAL, 'run-team');

      // A 建卡片并拖入进行中
      await server.upsertCard(boardId, { id: 'c1', title: '协同编辑 PoC', actor: '甲', ts: 8000 });
      let view = await server.moveCard(boardId, 'c1', { column: 'doing', position: 1, actor: '甲', ts: 8001 });
      check('8.1 看板卡片创建并落到 doing 列', view.cards[0].column === 'doing');

      // B 在另一端把卡片拖到 done（业务层 LWW，后写者胜）
      view = await server.moveCard(boardId, 'c1', { column: 'done', position: 1, actor: '乙', ts: 8002 });
      check('8.2 B 端移动卡片后位置同步', view.cards[0].column === 'done');

      // A 发起审批（另一端文档）
      let ap = await server.submitApproval(approvalId, {
        approvalId: 'run-team#1', instanceId: 'run-team', decision: 'note',
        note: '申请清理构建缓存', actor: '甲', ts: 8100,
      });
      check('8.3 A 发起审批成功', ap.applied === true);

      // B 在另一端批准
      ap = await server.submitApproval(approvalId, {
        approvalId: 'run-team#1', instanceId: 'run-team', decision: 'approve', note: '同意', actor: '乙', ts: 8101,
      });
      check('8.4 B 批准后审批动作已记录', ap.approvals[0].decision === 'approve');
      check('8.5 同一 approval-id 未被重复计数', ap.approvals.length === 1);
      check('8.6 审批裁决人归属正确', ap.approvals[0].actor === '乙');

      // B 重复点击批准（网络重试）→ 幂等
      ap = await server.submitApproval(approvalId, {
        approvalId: 'run-team#1', instanceId: 'run-team', decision: 'approve', note: '同意', actor: '乙', ts: 8102,
      });
      check('8.7 网络重试导致的重复批准被幂等去重', ap.deduped === true && ap.approvals.length === 1);

      // 看板墓碑：删除卡片后不再出现在列表
      view = await server.deleteCard(boardId, 'c1', { actor: '乙', reason: '需求取消' });
      check('8.8 看板卡片删除后列表为空', view.cards.length === 0);
      check('8.9 看板删除同样走 tombstone', view.tombstones.some(t => t.kind === 'card' && t.entityId === 'c1'));
    }

    // ── 场景九：docId 分片与非法输入校验 ──
    {
      const threadId = crdt.makeDocId(crdt.DOC_TYPES.THREAD, 42);
      check('9.1 docId 按业务实体分片', threadId === 'thread:42', threadId);
      check('9.2 docId 可反解类型与实体', crdt.parseDocId(threadId).type === crdt.DOC_TYPES.THREAD && crdt.parseDocId(threadId).entityId === '42');

      let e1 = null;
      try { crdt.makeDocId('unknown', '1'); } catch (err) { e1 = err; }
      check('9.3 未知文档类型被拒', !!e1 && e1.message.includes('未知的协同文档类型'));

      let e2 = null;
      try { crdt.makeDocId(crdt.DOC_TYPES.BOARD, ''); } catch (err) { e2 = err; }
      check('9.4 空实体 ID 被拒', !!e2 && e2.message.includes('不能为空'));

      let e3 = null;
      try { crdt.parseDocId('no-colon'); } catch (err) { e3 = err; }
      check('9.5 格式非法的 docId 被拒', !!e3 && e3.message.includes('格式非法'));

      let e4 = null;
      try { crdt.appendMessage(crdt.createDoc('thread:1'), { id: '', text: 'x' }); } catch (err) { e4 = err; }
      check('9.6 空消息 ID 被拒', !!e4 && e4.message.includes('消息 ID 不能为空'));

      // base64 往返
      const bytes = new Uint8Array([1, 2, 3, 250]);
      const rt = crdt.fromBase64(crdt.toBase64(bytes));
      check('9.7 base64 编解码往返无损', rt.length === 4 && rt[3] === 250);
    }
  } catch (err) {
    console.error('[测试异常]', err);
    results.push({ name: '测试执行', ok: false });
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length > 0 ? 1 : 0);
})();