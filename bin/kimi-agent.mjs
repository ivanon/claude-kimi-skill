#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from 'node:url';
import { existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

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

// 子命令专属选项白名单；--model/--timeout/--cwd/--dry-run/--output 为通用选项
const OPTION_COMMANDS = {
  '--focus': ['review', 'review-diff'],
  '--scope': ['review-plan', 'implement'],
  '--plan': ['implement'],
};

export function parseCliArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || !KNOWN_COMMANDS.includes(cmd)) throw new UsageError(`未知子命令: ${cmd ?? '(空)'}`);
  const requireApplicable = (option) => {
    if (!OPTION_COMMANDS[option].includes(cmd)) {
      throw new UsageError(`选项 ${option} 不适用于子命令 ${cmd}`);
    }
  };
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
      case '--focus': requireApplicable(a); opts.focus = takeValue(); break;
      case '--output': opts.output = takeValue(); break;
      case '--scope': requireApplicable(a); opts.scope.push(takeValue()); break;
      case '--plan': requireApplicable(a); opts.plan = takeValue(); break;
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

export function resolveInside(cwd, p, label) {
  const root = resolve(cwd);
  const abs = resolve(root, p);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new UsageError(`${label} 超出工作目录范围: ${p}`);
  }
  return abs;
}

export function diffRangeOf(opts) {
  return opts.positional.join(' ').trim() || 'HEAD';
}

export function precheck(opts) {
  const cwd = resolve(opts.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new UsageError(`--cwd 目录不存在: ${opts.cwd}`);
  }
  if (opts.cmd === 'review' || opts.cmd === 'review-plan') {
    const abs = resolveInside(cwd, opts.positional[0], '目标文件');
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new UsageError(`文件不存在: ${opts.positional[0]}`);
  }
  if (opts.plan) {
    const abs = resolveInside(cwd, opts.plan, '--plan 文件');
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new UsageError(`--plan 文件不存在: ${opts.plan}`);
  }
  // --scope 只做越界校验，不要求存在（允许指向将来才创建的路径）
  for (const s of opts.scope) resolveInside(cwd, s, '--scope 路径');
  if (opts.cmd === 'review-diff') {
    const gitOut = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    let inside = '';
    try { inside = gitOut(['rev-parse', '--is-inside-work-tree']).trim(); }
    catch (e) {
      if (e?.code === 'ENOENT') throw new UsageError('未找到 git 命令，请确认 git 已安装');
      // 其他失败视为非 git 目录，走下方统一报错
    }
    if (inside !== 'true') throw new UsageError('当前目录不是 git 仓库，无法 review diff');
    const range = diffRangeOf(opts);
    let numstat;
    try { numstat = gitOut(['diff', '--numstat', ...range.split(/\s+/)]); }
    catch (e) {
      const detail = e?.stderr?.toString().trim().split('\n')[0] ?? '';
      throw new UsageError(`无效的 git range: ${range}${detail ? `（${detail}）` : ''}`);
    }
    if (!numstat.trim()) throw new UsageError(`范围 ${range} 内没有可 review 的变更（注意：未跟踪的新文件不在 git diff 范围内，请先 git add）`);
  }
}

export function filterReport(text) {
  // 依据 kimi -p 真实输出校准：每条消息渲染为 "• " 开头的块（续行缩进 2 空格），
  // 最后一个块是最终回复；resume 提示可能直接粘在正文末尾（无换行分隔）。
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/To resume this session: kimi -r \S+/g, '');
  const lines = normalized.split('\n');
  const lastBlockStart = lines.findLastIndex((line) => line.startsWith('• '));
  let body;
  if (lastBlockStart === -1) {
    body = normalized;
  } else {
    const blockLines = [lines[lastBlockStart].slice(2)];
    for (let i = lastBlockStart + 1; i < lines.length; i++) {
      blockLines.push(lines[i].startsWith('  ') ? lines[i].slice(2) : lines[i]);
    }
    body = blockLines.join('\n');
  }
  body = body.replace(/\n{3,}/g, '\n\n').trim();
  return body === '' ? '' : `${body}\n`;
}

export function buildKimiArgs(prompt, opts) {
  const args = ['-p', prompt];
  if (opts.model) args.push('-m', opts.model);
  return args;
}

export function runKimi(prompt, opts) {
  return new Promise((resolvePromise, rejectPromise) => {
    const bin = process.env.KIMI_BIN || 'kimi';
    const child = spawn(bin, buildKimiArgs(prompt, opts), {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const chunks = [];
    let timedOut = false;
    // settled 防卫：error 事件后 close 仍会触发，确保 Promise 只 settle 一次
    let settled = false;
    const settle = (fn) => (value) => { if (!settled) { settled = true; fn(value); } };
    const done = settle(resolvePromise);
    const fail = settle(rejectPromise);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeout * 1000);
    // 下游管道提前关闭（如 | head）时 stdout 写入会 EPIPE：停止转发但继续缓冲，保证 --output 仍可落盘
    let stdoutBroken = false;
    const onStdoutError = (err) => {
      if (err?.code === 'EPIPE') { stdoutBroken = true; } else { throw err; }
    };
    process.stdout.on('error', onStdoutError);
    const cleanup = () => {
      clearTimeout(timer);
      process.stdout.removeListener('error', onStdoutError);
    };
    child.stdout.on('data', (chunk) => {
      if (!stdoutBroken) process.stdout.write(chunk);
      chunks.push(chunk);
    });
    child.on('error', (err) => {
      cleanup();
      if (err.code === 'ENOENT') {
        fail(new Error(`找不到 kimi 命令（${bin}）。请安装 kimi code CLI 并执行 kimi login，或设置 KIMI_BIN 指向可执行文件。`));
      } else {
        fail(err);
      }
    });
    child.on('close', (code) => {
      cleanup();
      if (timedOut) {
        fail(new Error(`kimi 执行超时（${opts.timeout}s），进程已终止`));
      } else {
        done({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
      }
    });
  });
}

const TEMPLATE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

const TEMPLATE_BY_CMD = {
  review: 'review-file.md',
  'review-plan': 'review-plan.md',
  'review-diff': 'review-diff.md',
  implement: 'implement.md',
};

export function buildVars(opts) {
  const scopeList = opts.scope.map((s) => `- ${s}`).join('\n');
  switch (opts.cmd) {
    case 'review': return { TARGET_FILE: opts.positional[0], FOCUS: opts.focus ?? '' };
    case 'review-plan': return { PLAN_FILE: opts.positional[0], SCOPE: scopeList };
    case 'review-diff': return { DIFF_RANGE: diffRangeOf(opts), FOCUS: opts.focus ?? '' };
    case 'implement': return { TASK: opts.positional[0], SCOPE: scopeList, PLAN_FILE: opts.plan ?? '' };
    default: throw new UsageError(`子命令 ${opts.cmd} 不使用模板`);
  }
}

export function buildPrompt(opts) {
  if (opts.cmd === 'run') return opts.positional[0];
  const file = resolve(TEMPLATE_DIR, TEMPLATE_BY_CMD[opts.cmd]);
  return renderTemplate(readFileSync(file, 'utf8'), buildVars(opts));
}

export async function main(argv) {
  let opts;
  let prompt;
  let outputAbs = null;
  try {
    opts = parseCliArgs(argv);
    precheck(opts);
    prompt = buildPrompt(opts);
    if (opts.output) {
      outputAbs = resolveInside(opts.cwd, opts.output, '--output 文件');
      if (existsSync(outputAbs) && statSync(outputAbs).isDirectory()) {
        throw new UsageError(`--output 路径是一个目录，无法写入文件: ${opts.output}`);
      }
    }
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`错误: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (opts.dryRun) {
    const bin = process.env.KIMI_BIN || 'kimi';
    process.stdout.write(`--- kimi 命令 ---\n${bin} ${buildKimiArgs('<prompt>', opts).join(' ')}\n--- prompt ---\n${prompt}\n`);
    return 0;
  }
  try {
    const { code, stdout } = await runKimi(prompt, opts);
    if (outputAbs) writeFileSync(outputAbs, filterReport(stdout));
    return code;
  } catch (e) {
    process.stderr.write(`错误: ${String(e?.message ?? e)}\n`);
    return 1;
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
