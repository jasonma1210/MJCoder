// 本地项目工作区：默认根目录 ~/Documents/.MJCoder，项目目录按 日期+随机数 创建
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const workspace = require('../main/workspace');

let pass = 0;
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.error(`[FAIL] ${name} — ${e.message}`); process.exitCode = 1; }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mjcode-ws-'));
  const docs = path.join(tmp, 'Documents');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  await check('工作区根目录是用户文档下的隐藏目录 .MJCoder', () => {
    assert.equal(workspace.workspaceRoot(docs, home), path.join(docs, '.MJCoder'));
  });

  await check('文档目录不可用时回退到 home', () => {
    assert.equal(workspace.workspaceRoot('', home), path.join(home, '.MJCoder'));
  });

  await check('日期+随机数戳格式为 20261013-4821', () => {
    const stamp = workspace.makeStamp(new Date(2026, 9, 13, 9, 0, 0));
    assert.match(stamp, /^20261013-\d{4}$/);
  });

  await check('未命名项目按 日期+随机数 目录名创建', async () => {
    const r = await workspace.createProject({ docsDir: docs, homeDir: home });
    assert.match(r.name, /^\d{8}-\d{4}$/);
    assert.ok(fs.existsSync(r.path));
    assert.equal(r.path, path.join(docs, '.MJCoder', r.name));
  });

  await check('命名项目使用清洗后的名称（空格折叠为连字符）', async () => {
    const r = await workspace.createProject({ docsDir: docs, homeDir: home, name: '  我的 商城 项目  ' });
    assert.equal(r.name, '我的-商城-项目');
    assert.ok(fs.existsSync(r.path));
  });

  await check('路径穿越名称被拒绝（fail-closed）', async () => {
    await assert.rejects(
      () => workspace.createProject({ docsDir: docs, homeDir: home, name: '../evil' }),
      /不合法/,
    );
    await assert.rejects(
      () => workspace.createProject({ docsDir: docs, homeDir: home, name: 'a/b' }),
      /不合法/,
    );
  });

  await check('清洗函数拒绝空值与超长名称', () => {
    assert.equal(workspace.sanitizeSegment('   '), null);
    assert.equal(workspace.sanitizeSegment('x'.repeat(200)), null);
    assert.equal(workspace.sanitizeSegment('a..b'), null);
    assert.equal(workspace.sanitizeSegment('正常名称-01'), '正常名称-01');
  });

  await check('同名目录不覆盖，自动追加 日期+随机数', async () => {
    const first = await workspace.createProject({ docsDir: docs, homeDir: home, name: 'dup' });
    const second = await workspace.createProject({ docsDir: docs, homeDir: home, name: 'dup' });
    assert.equal(first.name, 'dup');
    assert.match(second.name, /^dup-\d{8}-\d{4}$/);
    assert.notEqual(first.path, second.path);
    assert.ok(fs.existsSync(first.path) && fs.existsSync(second.path));
  });

  await check('首次访问时创建根目录并标记 created=true', async () => {
    const freshDocs = path.join(tmp, 'Documents2');
    fs.mkdirSync(freshDocs, { recursive: true });
    const first = await workspace.ensureWorkspaceRoot(freshDocs, home);
    assert.equal(first.created, true);
    const second = await workspace.ensureWorkspaceRoot(freshDocs, home);
    assert.equal(second.created, false);
    assert.ok(fs.existsSync(path.join(freshDocs, '.MJCoder')));
  });

  await check('工作区根目录确实以点开头（隐藏）', () => {
    assert.ok(workspace.WORKSPACE_DIR_NAME.startsWith('.'));
  });

  await check('文档与 home 均缺失时报中文错误', async () => {
    await assert.rejects(() => workspace.ensureWorkspaceRoot('', ''), /无法确定用户文档目录/);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nPASS：${pass}/${total} 项通过`);
})();