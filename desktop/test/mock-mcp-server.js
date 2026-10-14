// 模拟 MCP Server：严格按协议响应 initialize / notifications/initialized / tools/list / tools/call
process.stdin.setEncoding('utf8');
let buf = '';

process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    if (msg.method === 'initialize') {
      respond(msg.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'mock-mcp', version: '1.0' } });
    } else if (msg.method === 'notifications/initialized') {
      // 通知无需响应
    } else if (msg.method === 'tools/list') {
      respond(msg.id, {
        tools: [
          { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
          { name: 'add', description: '两数相加', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
        ],
      });
    } else if (msg.method === 'tools/call') {
      const { name, arguments: args } = msg.params;
      if (name === 'echo') respond(msg.id, { content: [{ type: 'text', text: `echo: ${args.text}` }] });
      else if (name === 'add') respond(msg.id, { content: [{ type: 'text', text: String(args.a + args.b) }] });
      else respond(msg.id, null, { code: -32601, message: 'unknown tool' });
    }
  }
});

function respond(id, result, error) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result, error }) + '\n');
}
