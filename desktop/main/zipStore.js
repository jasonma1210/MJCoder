// T2-6：最小 ZIP 实现（store 方法，无压缩，零依赖）
// 为什么自写：诊断包是纯文本 JSONL/小配置，压缩收益低；而引入 archiver/adm-zip
// 这类依赖与项目「桌面端零多余依赖」的纪律冲突（desktop 运行时依赖仅 4 个）。
// store 格式是 ZIP 的最小子集（无压缩、UTF-8 文件名），任何 unzip/归档工具可读。
// 纪律：只支持「写小文件」与「测试用读」，不做流式/大文件/加密——超出范围请换库。
const fs = require('fs');

// ── CRC32（ZIP 多项式反射表，与 zlib 同值）──
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 写 store-method zip。
 * @param {Array<{name:string, data:Buffer|string}>} entries 条目（name 用正斜杠路径）
 * @param {string} outPath 输出文件
 */
function writeZip(entries, outPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name), 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    // local file header（PK\x03\x04）：版本 20 / 通用标志 0x0800(UTF-8) / 方法 0(store)
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x0800, 6);
    lfh.writeUInt16LE(0, 8);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18); // compressed size == 未压缩 size（store）
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    locals.push(lfh, nameBuf, data);
    // central directory header（PK\x01\x02）
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x0800, 8);
    cdh.writeUInt16LE(0, 10);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(data.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42); // 本地头相对偏移
    centrals.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  fs.writeFileSync(outPath, Buffer.concat([...locals, central, eocd]));
  return outPath;
}

/**
 * 读 store-method zip（测试/校验用）。返回 [{ name, data }]。
 * 简化假设：本模块自写的 zip（方法必为 0），不处理压缩条目。
 */
function readZip(buf) {
  const eocdPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdPos < 0) throw new Error('非 zip 文件：找不到 EOCD');
  const count = buf.readUInt16LE(eocdPos + 10);
  let p = buf.readUInt32LE(eocdPos + 16);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (method !== 0) throw new Error(`不支持的压缩方法 ${method}（本实现只读 store）`);
    // 本地头长度可变（名字/extra 字段），按 localOff 解析后取数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    out.push({ name, data: buf.slice(dataStart, dataStart + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { writeZip, readZip, crc32 };
