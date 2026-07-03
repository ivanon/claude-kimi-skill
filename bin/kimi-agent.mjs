#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

export class UsageError extends Error {}

export const USAGE = `用法:
  kimi-agent review <file> [--focus "关注点"] [--output <file>]
  kimi-agent review-plan <plan文件> [--scope <路径>]... [--output <file>]
  kimi-agent review-diff [<git range>] [--focus "关注点"] [--output <file>]
  kimi-agent implement "<需求描述>" [--scope <路径>]... [--plan <设计文档>]
  kimi-agent run "<自由prompt>"

通用选项:
  --model <m>      透传 kimi -m
  --timeout <sec>  默认 600，超时 kill
  --cwd <dir>      默认当前目录
  --dry-run        只打印最终 prompt 与 kimi 命令行，不实际调用
`;

const KNOWN_COMMANDS = ['review', 'review-plan', 'review-diff', 'implement', 'run'];

export function renderTemplate(template, vars) {
  template = template.replace(/\r\n/g, '\n'); // 归一化 CRLF，可选块正则只处理 LF
  // 先处理可选块：{{#VAR}} 与 {{/VAR}} 各独占一行
  let out = template.replace(
    /^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n?/gm,
    (_, name, body) => hasValue(vars[name]) ? body : ''
  );
  // 再替换普通占位符；无值即为缺少必填变量
  out = out.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    if (!hasValue(vars[name])) throw new UsageError(`缺少必填变量: ${name}`);
    return String(vars[name]);
  });
  return out;
}

function hasValue(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

export async function main(argv) {
  const cmd = argv[0];
  if (!cmd || !KNOWN_COMMANDS.includes(cmd)) {
    process.stderr.write(`错误: 未知子命令: ${cmd ?? '(空)'}\n\n${USAGE}`);
    return 2;
  }
  return 0; // 后续任务替换为完整流程
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`错误: ${String(err?.message ?? err)}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    }
  );
}
