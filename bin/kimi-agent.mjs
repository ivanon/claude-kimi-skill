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

export function parseCliArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !KNOWN_COMMANDS.includes(cmd)) throw new UsageError(`未知子命令: ${cmd ?? '(空)'}`);
  const opts = {
    cmd, positional: [], scope: [],
    focus: null, output: null, plan: null, model: null,
    timeout: 600, cwd: process.cwd(), dryRun: false,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') {
      opts.positional.push(...rest.slice(i + 1));
      break;
    }
    const takeValue = () => {
      i += 1;
      if (i >= rest.length) throw new UsageError(`选项 ${a} 缺少值`);
      return rest[i];
    };
    const takeNonEmpty = () => {
      const v = takeValue();
      if (!v.trim()) throw new UsageError(`选项 ${a} 的值不能为空`);
      return v;
    };
    switch (a) {
      case '--focus': opts.focus = takeValue(); break;
      case '--output': opts.output = takeValue(); break;
      case '--scope': opts.scope.push(takeValue()); break;
      case '--plan': opts.plan = takeValue(); break;
      case '--model': opts.model = takeNonEmpty(); break;
      case '--cwd': opts.cwd = takeNonEmpty(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--timeout': {
        const v = Number(takeValue());
        if (!Number.isFinite(v) || v <= 0) throw new UsageError('--timeout 必须是正数（秒）');
        opts.timeout = v;
        break;
      }
      default:
        if (a.startsWith('--') && cmd !== 'review-diff') throw new UsageError(`未知选项: ${a}`);
        opts.positional.push(a);
    }
  }
  if ((cmd === 'review' || cmd === 'review-plan') && opts.positional.length !== 1) {
    throw new UsageError(`${cmd} 需要且仅需要一个目标文件参数`);
  }
  if ((cmd === 'implement' || cmd === 'run') && (opts.positional.length !== 1 || !opts.positional[0].trim())) {
    throw new UsageError(`${cmd} 需要一个非空的描述参数`);
  }
  return opts;
}

export function filterReport(text) {
  const body = text
    .split('\n')
    .filter((line) => !line.startsWith('• '))
    .filter((line) => !line.startsWith('To resume this session'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return body === '' ? '' : `${body}\n`;
}

export async function main(argv) {
  try {
    const opts = parseCliArgs(argv);
    void opts; // 后续任务接入 precheck / buildPrompt / runKimi
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`错误: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
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
