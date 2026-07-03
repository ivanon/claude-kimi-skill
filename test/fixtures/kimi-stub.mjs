#!/usr/bin/env node
// 冒充 kimi 的 stub：记录收到的 argv，输出与真实 kimi 同构的样本
import { writeFileSync } from 'node:fs';

if (process.env.STUB_ARGS_FILE) {
  writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.STUB_SLEEP_MS) {
  await new Promise((r) => setTimeout(r, Number(process.env.STUB_SLEEP_MS)));
}
process.stdout.write('• 思考：正在分析\n');
process.stdout.write('# stub 报告\n\n- 发现 1 个问题\n正文中包含 • 字符但不在行首\n');
process.stdout.write('\nTo resume this session: kimi -r session_stub\n');
process.exit(Number(process.env.STUB_EXIT ?? 0));
