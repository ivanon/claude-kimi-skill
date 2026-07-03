#!/usr/bin/env node
// 冒充 kimi 的 stub：记录收到的 argv，输出与真实 kimi -p 同构的样本
// （真实格式：每条消息 "• " 开头、续行缩进 2 空格，最后一块是最终回复，
//   resume 提示直接粘在正文末尾，依据 2026-07-03 冒烟样本校准）
import { writeFileSync } from 'node:fs';

if (process.env.STUB_ARGS_FILE) {
  writeFileSync(process.env.STUB_ARGS_FILE, JSON.stringify(process.argv.slice(2)));
}
if (process.env.STUB_SLEEP_MS) {
  await new Promise((r) => setTimeout(r, Number(process.env.STUB_SLEEP_MS)));
}
process.stdout.write('• 思考：正在分析\n\n');
if (process.env.STUB_SPLIT_MS) {
  await new Promise((r) => setTimeout(r, Number(process.env.STUB_SPLIT_MS)));
}
process.stdout.write('• # stub 报告\n\n  - 发现 1 个问题\n  正文中包含 • 字符但不在行首To resume this session: kimi -r session_stub\n\n');
process.exit(Number(process.env.STUB_EXIT ?? 0));
