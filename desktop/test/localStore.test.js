// 本地数据层测试：线程/消息 CRUD / 原子持久化 / 凭证隔离 / 记忆上限
const fs = require('fs');
const path = require('path');
const os = require('os');
const { LocalStore } = require('../main/localStore');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-'));
const store = new LocalStore(dir);

// ── 线程与消息 ──
const t = store.createThread({ title: '新对话', cwd: '/tmp/p', providerName: 'DS', modelName: 'deepseek-chat' });
check('创建线程', !!t.id && t.cwd === '/tmp/p');
const m1 = store.addMessage({ threadId: t.id, role: 'user', content: '帮我看看仓库', tokensInput: 10, tokensOutput: 0 });
check('用户消息入库并自动设标题', store.listThreads()[0].title.startsWith('帮我看看仓库'));
store.addMessage({ threadId: t.id, role: 'assistant', content: '这是一个 git 仓库', tokensOutput: 8 });
const msgs = store.listMessages(t.id);
check('消息按序返回', msgs.length === 2 && msgs[0].role === 'user' && msgs[1].role === 'assistant');

// ── 原子持久化：新实例从磁盘恢复 ──
store.flushSync(); // P0-1：消息走合并刷盘，读盘断言前强制落盘
const store2 = new LocalStore(dir);
check('磁盘恢复：线程与消息完整', store2.listThreads().length === 1 && store2.listMessages(t.id).length === 2);

// ── 凭证隔离 ──
store.addProvider({ name: 'DS', base_url: 'https://api.deepseek.com/v1', keyEncrypted: 'ENC(base64)', modelId: 'deepseek-chat' });
const plist = store.listProviders();
check('listProviders 不泄露 keyEncrypted', !JSON.stringify(plist).includes('ENC(base64)'));
check('getProviderKey 仅供调用方解密', store.getProviderKey(plist[0].id) === 'ENC(base64)');
store.setProviderModel(plist[0].id, 'deepseek-reasoner');
check('setProviderModel 更新模型', store.listProviders()[0].modelId === 'deepseek-reasoner');

// ── 归档 ──
store.archiveThread(t.id);
check('归档后列表不可见', store.listThreads().length === 0);

// ── 记忆上限 ──
for (let i = 0; i < 55; i++) store.addMemory({ projectPath: '/p', content: `记忆 ${i}` });
check('记忆上限 50 条（淘汰最旧）', store.listMemories('/p', 100).length === 50);
check('记忆按项目过滤', store.listMemories('/other', 10).length === 0);

// ── P1-M：损坏韧性——先 .bak 恢复，无 .bak 才重置（此前一损坏就静默空库）──
// 此时共享 dir 的 .bak 已由历次 flush 生成（含 provider）
fs.writeFileSync(path.join(dir, 'local-data.json'), '{broken json');
const store3 = new LocalStore(dir);
check('损坏文件从 .bak 恢复（不静默重置）', store3.recoveredFromBackup === true && Array.isArray(store3.listThreads()));
check('恢复后凭证未丢', store3.listProviders().length === 1);

// 无 .bak 的损坏文件 → 重置空库且不崩溃
const dirNoBak = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-nobak-'));
fs.writeFileSync(path.join(dirNoBak, 'local-data.json'), '{also broken');
const storeNoBak = new LocalStore(dirNoBak);
check('无 .bak 的损坏文件回落空库不崩溃', storeNoBak.listThreads().length === 0 && storeNoBak.recoveredFromBackup === false);

// flush 留 .bak（上一完好版本）+ 按日副本
const dirBak = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-bak-'));
const s5 = new LocalStore(dirBak);
s5.createThread({ title: 'a', cwd: '/tmp/x' });
const fileAfterFirst = fs.readFileSync(path.join(dirBak, 'local-data.json'), 'utf8');
s5.createThread({ title: 'b', cwd: '/tmp/x' });
check('flush 前留 .bak（上一完好版本）',
  fs.existsSync(path.join(dirBak, 'local-data.json.bak'))
  && fs.readFileSync(path.join(dirBak, 'local-data.json.bak'), 'utf8') === fileAfterFirst);
check('按日副本已生成', fs.existsSync(path.join(dirBak, `local-data.${new Date().toISOString().slice(0, 10)}.json`)));

// 恢复后的首次 flush 不得用好 .bak 去覆盖……方向反了：不得让坏主文件污染好 .bak
fs.writeFileSync(path.join(dirBak, 'local-data.json'), '{broken');
const s6 = new LocalStore(dirBak);
s6.createThread({ title: 'c', cwd: '/tmp/x' });
check('恢复后 flush 不被坏文件污染 .bak',
  JSON.parse(fs.readFileSync(path.join(dirBak, 'local-data.json.bak'), 'utf8')).threads.length === 1);

// schemaVersion 与旧版迁移
check('schemaVersion 已写入', s6.data.schemaVersion === 1);
const dirMig = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-mig-'));
fs.writeFileSync(path.join(dirMig, 'local-data.json'), JSON.stringify({ threads: [], providers: [{ id: 9, name: 'old', modelId: 'm1' }], seq: 10 }));
const s7 = new LocalStore(dirMig);
check('旧版无版本文件迁移出 models 并 Stamp 版本',
  Array.isArray(s7.listProviders()[0].models) && s7.listProviders()[0].models[0].modelId === 'm1' && s7.data.schemaVersion === 1);

// 超过 7 天的按日副本被清理
fs.writeFileSync(path.join(dirMig, 'local-data.2020-01-01.json'), '{}');
s7.createThread({ title: 'trigger', cwd: '/tmp/x' });
check('超过 7 天的按日副本被清理', !fs.existsSync(path.join(dirMig, 'local-data.2020-01-01.json')));

// ── /compact 落库：replaceMessages 整体替换（P2-6 收口）──
const tc = store.createThread({ title: '压缩测试', cwd: '/tmp/c' });
store.addMessage({ threadId: tc.id, role: 'user', content: '第一个问题' });
store.addMessage({ threadId: tc.id, role: 'assistant', content: '第一个回答' });
store.addMessage({ threadId: tc.id, role: 'user', content: '第二个问题' });
store.addMessage({ threadId: tc.id, role: 'assistant', content: '第二个回答' });
store.flushSync(); // P0-1：合并窗口内的消息落盘后再做后续读盘断言
const rRepl = store.replaceMessages(tc.id, [
  { role: 'assistant', content: '【摘要】此前讨论了两个问题与结论。' },
  { role: 'user', content: '继续第三个问题' },
]);
const afterRepl = store.listMessages(tc.id);
check('replaceMessages 替换成功', rRepl.ok === true);
check('替换后消息数与内容正确',
  afterRepl.length === 2 && afterRepl[0].content.includes('摘要') && afterRepl[1].role === 'user');
const storeR = new LocalStore(dir);
check('替换结果落盘（重进会话不回退）', storeR.listMessages(tc.id).length === 2);
check('拒绝空列表（不得清空历史）', store.replaceMessages(tc.id, []).ok === false && store.listMessages(tc.id).length === 2);
check('线程不存在时报错', store.replaceMessages(999999, [{ role: 'user', content: 'x' }]).ok === false);
// 其余会话消息不受影响（t.id 有 2 条早期消息）
check('replaceMessages 不误伤其它会话', store.listMessages(t.id).length === 2);

// ── P0-1：消息热路径合并刷盘（主进程不再被每条消息一次的整库同步写阻塞）──
const dirHot = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-hot-'));
const sHot = new LocalStore(dirHot);
const tHot = sHot.createThread({ title: '热路径', cwd: '/tmp/hot' }); // 同步 flush
let diskWrites = 0;
const origWriteFile = fs.writeFileSync;
fs.writeFileSync = function (...args) {
  if (String(args[0]).includes('local-data')) diskWrites++;
  return origWriteFile.apply(fs, args);
};
for (let i = 0; i < 20; i++) {
  sHot.addMessage({ threadId: tHot.id, role: 'user', content: `消息 ${i}` }); // 合并窗口内不落盘
}
const writesBeforeFlush = diskWrites;
sHot.flushSync();
fs.writeFileSync = origWriteFile;
check('20 条消息合并为少量写盘（≤2 次磁盘写）', writesBeforeFlush <= 2,
  `合并窗口内写盘 ${writesBeforeFlush} 次`);
check('合并刷盘后 20 条消息完整落盘', new LocalStore(dirHot).listMessages(tHot.id).length === 20);
check('flushSync 幂等（无脏数据不再写盘）', sHot.flushSync() === false);

// scheduleFlush 定时器到期自动落盘（异步段收尾，统一在此清理与退出）
(async () => {
  const dirTimer = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-local-timer-'));
  const sT = new LocalStore(dirTimer);
  const tT = sT.createThread({ title: '定时器', cwd: '/tmp/t' });
  sT.addMessage({ threadId: tT.id, role: 'user', content: '异步合并消息' });
  await new Promise((r) => setTimeout(r, 400)); // 默认合并窗口 150ms，400ms 后应已自动落盘
  check('scheduleFlush 到期自动落盘（无需 flushSync）', new LocalStore(dirTimer).listMessages(tT.id).length === 1);
  sT.flushSync();

  fs.rmSync(dirNoBak, { recursive: true, force: true });
  fs.rmSync(dirBak, { recursive: true, force: true });
  fs.rmSync(dirMig, { recursive: true, force: true });
  fs.rmSync(dirHot, { recursive: true, force: true });
  fs.rmSync(dirTimer, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}：${pass}/${pass + fail} 项通过`);
  process.exit(fail === 0 ? 0 : 1);
})();
