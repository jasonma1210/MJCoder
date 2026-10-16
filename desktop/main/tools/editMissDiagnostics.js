// editFile 未命中诊断（2026-10-16 自 tools/exec.js 拆出——exec.js 逼近 800 行 God File 门禁）
// 背景（真机反馈）：「未找到要替换的内容」这句话本身不可行动——模型不知道是文件被前面的
// 步骤改过了、还是自己缩进抄错、还是换行符差异，唯一能做的就是原样再试一次，
// 于是同一个失败片段被重试到轮次耗尽，用户看到「明明改完了却一直在转」。
// 原则：**工具失败必须回传可行动信息**（为什么失败 + 文件现在长什么样 + 下一步该做什么）。
// 背景（真机反馈）：「未找到要替换的内容」这句话本身不可行动——模型不知道是文件被前面的
// 步骤改过了、还是自己缩进抄错、还是换行符差异，唯一能做的就是原样再试一次，
// 于是同一个失败片段被重试到轮次耗尽，用户看到「明明改完了却一直在转」。
// 原则：**工具失败必须回传可行动信息**（为什么失败 + 文件现在长什么样 + 下一步该做什么）。
function diagnoseEditMiss(fileContent, search) {
  const src = String(fileContent || '');
  if (src.length === 0) {
    return { reason: '文件为空（0 字节）', preview: '', hints: ['文件当前没有任何内容：要写入全文请改用 write_file，edit_file 只能替换已有文本。'] };
  }
  const hints = [];
  const norm = (s) => String(s || '').replace(/\r\n/g, '\n');
  if (norm(src).includes(norm(search))) {
    hints.push('差异只来自换行符：文件用 CRLF（\\r\\n）而你给的是 LF（\\n），或反之。请按 read_file 返回的原始内容原样复制。');
  }
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  if (squash(src).includes(squash(search))) {
    hints.push('差异只来自空白（缩进空格数 / 制表符 / 空行）。请逐字符比对缩进，或改用更长且唯一的片段定位。');
  }
  const firstLine = String(search).split('\n').find((l) => l.trim()) || '';
  if (firstLine && src.includes(firstLine)) {
    hints.push('片段首行在文件中存在，但后续行不匹配——这一处很可能已被前面的步骤改掉了；请先确认该步骤是否其实已经完成，不要重复修改。');
  }
  if (!hints.length) {
    hints.push('该片段可能已被前面的步骤修改或删除，也可能你改的是另一个文件。请先用 read_file 读取当前内容确认，再给出精确片段。');
  }
  return { reason: '文件中不存在该精确片段', preview: String(search).slice(0, 120).replace(/\n/g, '\\n'), hints };
}

// 未命中时给出「文件里最接近的锚点」：模型据此重新对齐，而不是盲改。
// 即使一行都对不上也必须回传文件当前样貌（回退到开头若干行）——
// 否则模型手里既没有旧片段也没有新内容，只剩「再试一次」这一个选项。
function nearestContext(fileContent, search) {
  const lines = String(fileContent || '').split('\n');
  if (!lines.length) return null;
  const needles = String(search || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let best = -1;
  let bestScore = 0;
  if (needles.length) {
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      const score = needles.filter((n) => t.includes(n) || n.includes(t)).length;
      if (score > bestScore) { bestScore = score; best = i; }
    });
  }
  const anchor = best >= 0 ? best : 0; // 无相似行：退回文件开头，至少让模型看到现状
  const from = Math.max(0, anchor - 2);
  const to = Math.min(lines.length, anchor + 3);
  return {
    line: anchor + 1,
    matched: best >= 0,
    snippet: lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n').slice(0, 800),
  };
}


module.exports = { diagnoseEditMiss, nearestContext };
