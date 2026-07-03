# kimi-agent Skill 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 kimi-agent skill——零依赖 Node 脚本 + 固定 prompt 模板，让 Claude 通过 CLI 调用 kimi code 完成 review 与 TDD 开发任务。

**Architecture:** 单文件 ESM 脚本 `bin/kimi-agent.mjs` 导出纯函数（模板渲染、参数解析、预检查、输出过滤）并在直接执行时跑 `main()`；prompt 模板是 `prompts/` 下的 markdown 文件，变量替换完全由代码完成；通过 `spawn` 调用 `kimi -p <prompt> -y`（`KIMI_BIN` 可覆盖，测试用 stub 冒充）。

**Tech Stack:** Node.js ≥20（ESM、`node:test`、`node:child_process`），零运行时依赖。

**Spec:** `docs/superpowers/specs/2026-07-03-kimi-agent-skill-design.md`（实现时须对照，行为细节以 spec 为准）

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `package.json` | 元数据、`bin` 注册、`npm test` 脚本；无 dependencies |
| `bin/kimi-agent.mjs` | 唯一实现文件：`UsageError`、`renderTemplate`、`parseCliArgs`、`filterReport`、`precheck`、`buildKimiArgs`、`runKimi`、`buildVars`、`buildPrompt`、`main` |
| `prompts/review-file.md` | 单文件/文档 review 模板 |
| `prompts/review-plan.md` | plan-based review 模板 |
| `prompts/review-diff.md` | diff review 模板 |
| `prompts/implement.md` | TDD 实现模板 |
| `test/helpers.mjs` | 测试助手（`runCli`、临时项目/git 仓库工厂），供三个测试文件复用，自身不含用例 |
| `test/unit.test.mjs` | 纯函数单元测试（渲染/解析/过滤/预检查） |
| `test/integration.test.mjs` | 经 stub kimi 的端到端集成测试 |
| `test/templates.test.mjs` | 四个模板渲染后的内容断言 |
| `test/fixtures/kimi-stub.mjs` | 冒充 kimi 的 stub 脚本 |
| `SKILL.md` | skill 定义：触发条件、调用方式、映射表、风险提示 |
| `README.md` | 安装、用法、troubleshooting |

说明：spec 目录树中测试写作 `test/kimi-agent.test.mjs` 单文件；实现按职责拆为三个测试文件 + fixtures，属允许的结构细化。

## 全局约定（所有任务生效）

- 退出码：用法/参数/路径/预检查错误 = **2**；运行时错误（kimi 缺失、超时）= **1**；kimi 正常结束 = 透传 kimi 退出码。
- `UsageError` 表示 exit 2 一类的错误；`main()` 返回退出码而非直接 `process.exit`，入口处再退出。
- 中文错误信息，stderr 输出。
- 每个任务完成即 commit。

---

## Task 1: 项目骨架与 CLI 入口

**Files:**
- Create: `package.json`
- Create: `bin/kimi-agent.mjs`
- Test: `test/unit.test.mjs`

- [ ] **Step 1: 写 package.json**

```json
{
  "name": "claude-kimi-agent-skill",
  "version": "0.1.0",
  "description": "Claude Code skill: 调用 kimi code CLI 执行 review 与 TDD 开发任务",
  "type": "module",
  "bin": { "kimi-agent": "bin/kimi-agent.mjs" },
  "scripts": { "test": "node --test test/" },
  "engines": { "node": ">=20" },
  "license": "MIT"
}
```

- [ ] **Step 2: 写测试助手与失败测试（未知子命令 exit 2 + stderr 含用法）**

`test/helpers.mjs`（纯助手，无用例；后续任务会继续往这里加工厂函数）：

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pExecFile = promisify(execFile);
export const CLI = fileURLToPath(new URL('../bin/kimi-agent.mjs', import.meta.url));

// 运行 CLI，永不 reject，统一返回 { code, stdout, stderr }
export async function runCli(args, { env = {}, cwd } = {}) {
  try {
    const r = await pExecFile('node', [CLI, ...args], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
```

`test/unit.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.mjs';

test('未知子命令：exit 2 且 stderr 含用法', async () => {
  const r = await runCli(['nonsense']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知子命令/);
  assert.match(r.stderr, /用法/);
});

test('无参数：exit 2 且 stderr 含用法', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /用法/);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（`bin/kimi-agent.mjs` 不存在，spawn 报错或断言失败）

- [ ] **Step 4: 写最小实现（脚本骨架）**

`bin/kimi-agent.mjs`：

```js
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
    (err) => { process.stderr.write(`错误: ${err.message}\n`); process.exit(1); }
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS（2 个用例）

- [ ] **Step 6: Commit**

```bash
git add package.json bin/kimi-agent.mjs test/helpers.mjs test/unit.test.mjs
git commit -m "feat: kimi-agent CLI 骨架与用法校验"
```

## Task 2: 模板渲染 renderTemplate

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加导出，不动已有代码）
- Test: `test/unit.test.mjs`（追加用例）

模板语法（spec 第 7 节）：
- `{{VAR}}` 必填占位符，值为空/未提供 → `UsageError`，错误信息含变量名。
- `{{#VAR}}`（独占一行）… `{{/VAR}}`（独占一行）可选块：变量有值时去掉首尾标记行、替换块内 `{{VAR}}`；无值时整块删除。

- [ ] **Step 1: 写失败测试**

追加到 `test/unit.test.mjs`：

```js
import { renderTemplate, UsageError } from '../bin/kimi-agent.mjs';

test('renderTemplate: 必填变量替换', () => {
  assert.equal(renderTemplate('评审 {{TARGET_FILE}} 结束', { TARGET_FILE: 'a.ts' }), '评审 a.ts 结束');
});

test('renderTemplate: 必填变量缺失时抛 UsageError 且含变量名', () => {
  assert.throws(() => renderTemplate('评审 {{TARGET_FILE}}', {}), (e) => e instanceof UsageError && /TARGET_FILE/.test(e.message));
  assert.throws(() => renderTemplate('评审 {{TARGET_FILE}}', { TARGET_FILE: '' }), UsageError);
});

const TPL = `## 要求
- 只读
{{#FOCUS}}
## 重点关注
{{FOCUS}}
{{/FOCUS}}

## 输出格式
`;

test('renderTemplate: 可选块有值时展开', () => {
  const out = renderTemplate(TPL, { FOCUS: '并发安全' });
  assert.match(out, /## 重点关注\n并发安全\n/);
  assert.doesNotMatch(out, /\{\{/);
});

test('renderTemplate: 可选块无值时整块删除', () => {
  const out = renderTemplate(TPL, {});
  assert.doesNotMatch(out, /重点关注/);
  assert.doesNotMatch(out, /\{\{/);
  assert.match(out, /## 输出格式/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL with "renderTemplate is not exported"（或同义报错）

- [ ] **Step 3: 写最小实现**

追加到 `bin/kimi-agent.mjs`：

```js
export function renderTemplate(template, vars) {
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（6 个用例）

- [ ] **Step 5: Commit**

```bash
git add bin/kimi-agent.mjs test/unit.test.mjs
git commit -m "feat: 模板渲染（可选块 + 必填变量校验）"
```

## Task 3: 参数解析 parseCliArgs

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加 `parseCliArgs`，并让 `main` 使用它）
- Test: `test/unit.test.mjs`（追加用例）

解析规则（spec 第 6 节）：
- `--scope` 可重复，收集为数组。
- `review-diff` 的 range 是自由 positional：以 `--` 开头的未知项对 review-diff 视为 range 的一部分（如 `--cached`），其他子命令下则报未知选项；多个 positional 用空格拼接。
- `--timeout` 必须为正数（秒），默认 600。

- [ ] **Step 1: 写失败测试**

追加到 `test/unit.test.mjs`：

```js
import { parseCliArgs } from '../bin/kimi-agent.mjs';

test('parseCliArgs: review 基本解析与默认值', () => {
  const o = parseCliArgs(['review', 'src/a.ts', '--focus', '并发', '--output', 'r.md']);
  assert.equal(o.cmd, 'review');
  assert.deepEqual(o.positional, ['src/a.ts']);
  assert.equal(o.focus, '并发');
  assert.equal(o.output, 'r.md');
  assert.equal(o.timeout, 600);
  assert.equal(o.dryRun, false);
  assert.equal(o.cwd, process.cwd());
});

test('parseCliArgs: --scope 可重复收集', () => {
  const o = parseCliArgs(['implement', '加登录', '--scope', 'src/', '--scope', 'test/', '--plan', 'docs/d.md']);
  assert.deepEqual(o.scope, ['src/', 'test/']);
  assert.equal(o.plan, 'docs/d.md');
});

test('parseCliArgs: review-diff 允许 --cached 作为 range', () => {
  const o = parseCliArgs(['review-diff', '--cached']);
  assert.deepEqual(o.positional, ['--cached']);
});

test('parseCliArgs: 其他子命令下未知 -- 选项报错', () => {
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--cached']), UsageError);
});

test('parseCliArgs: 缺少必要 positional 报错', () => {
  assert.throws(() => parseCliArgs(['review']), UsageError);
  assert.throws(() => parseCliArgs(['review-plan']), UsageError);
  assert.throws(() => parseCliArgs(['implement', '   ']), UsageError);
  assert.throws(() => parseCliArgs(['run']), UsageError);
});

test('parseCliArgs: 选项缺值 / 非法 timeout 报错', () => {
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--focus']), UsageError);
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--timeout', '-5']), UsageError);
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--timeout', 'abc']), UsageError);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL with "parseCliArgs is not exported"

- [ ] **Step 3: 写最小实现**

追加到 `bin/kimi-agent.mjs`（`KNOWN_COMMANDS` 已在 Task 1 定义）：

```js
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
    const takeValue = () => {
      i += 1;
      if (i >= rest.length) throw new UsageError(`选项 ${a} 缺少值`);
      return rest[i];
    };
    switch (a) {
      case '--focus': opts.focus = takeValue(); break;
      case '--output': opts.output = takeValue(); break;
      case '--scope': opts.scope.push(takeValue()); break;
      case '--plan': opts.plan = takeValue(); break;
      case '--model': opts.model = takeValue(); break;
      case '--cwd': opts.cwd = takeValue(); break;
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
```

同时把 `main` 中手写的子命令校验换成 `parseCliArgs`：

```js
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
```

注意：Task 1 的两个 CLI 测试断言 `未知子命令` 与 `用法`，本改动保持其通过。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（12 个用例）

- [ ] **Step 5: Commit**

```bash
git add bin/kimi-agent.mjs test/unit.test.mjs
git commit -m "feat: CLI 参数解析（五子命令 + 通用选项）"
```

## Task 4: 输出过滤 filterReport

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加 `filterReport`）
- Test: `test/unit.test.mjs`（追加用例）

过滤规则（spec 第 8 节，仅作用于 `--output` 落盘文件，不影响 stdout）：删除以 `• ` 开头的思考行、删除以 `To resume this session` 开头的尾行、压缩三连以上空行、末尾保留单个换行。行中间出现的 `•` 不受影响。

- [ ] **Step 1: 写失败测试**

追加到 `test/unit.test.mjs`：

```js
import { filterReport } from '../bin/kimi-agent.mjs';

test('filterReport: 过滤思考行与 resume 尾行，保留正文', () => {
  const raw = [
    '• 思考：正在分析代码',
    '# review 报告',
    '',
    '- 正常列表项',
    '正文中包含 • 字符但不在行首',
    '',
    'To resume this session: kimi -r session_abc123',
  ].join('\n');
  const out = filterReport(raw);
  assert.doesNotMatch(out, /思考：/);
  assert.doesNotMatch(out, /To resume this session/);
  assert.match(out, /# review 报告/);
  assert.match(out, /- 正常列表项/);
  assert.match(out, /正文中包含 • 字符但不在行首/);
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
});

test('filterReport: 连续思考行删除后不留三连空行', () => {
  const raw = '• a\n• b\n\n\n\n正文\n';
  const out = filterReport(raw);
  assert.doesNotMatch(out, /\n{3,}/);
  assert.match(out, /正文/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL with "filterReport is not exported"

- [ ] **Step 3: 写最小实现**

追加到 `bin/kimi-agent.mjs`：

```js
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（14 个用例）

- [ ] **Step 5: Commit**

```bash
git add bin/kimi-agent.mjs test/unit.test.mjs
git commit -m "feat: 落盘报告过滤（思考行 / resume 尾行）"
```

## Task 5: 预检查 precheck

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加 `resolveInside`、`precheck`）
- Test: `test/unit.test.mjs`（追加用例）

预检查规则（spec 第 6、8 节）：
- 所有用户给的路径规范化为绝对路径，必须落在 `--cwd` 子树内，越界 → `UsageError`。
- `review` / `review-plan` 的目标文件必须存在且是文件；`--plan` 文件必须存在。
- `review-diff` 三态检查：非 git 仓库、非法 range、空 diff，均 `UsageError`。
- diff 内容不读入，只验证 range 可用（`git diff --numstat`）。

- [ ] **Step 1: 写失败测试**

追加到 `test/helpers.mjs`（临时项目/git 仓库工厂，供本任务与集成测试共用）：

```js
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'kimi-agent-test-'));
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
  return dir;
}

export function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

export function makeGitProject() {
  const dir = makeTmpProject();
  git(dir, 'init');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}
```

追加到 `test/unit.test.mjs`（顶部补充 import）：

```js
import { writeFileSync as fsWrite } from 'node:fs';
import { join } from 'node:path';
import { makeTmpProject, makeGitProject } from './helpers.mjs';
import { precheck, resolveInside } from '../bin/kimi-agent.mjs';

test('resolveInside: cwd 内路径通过，越界抛 UsageError', () => {
  const dir = makeTmpProject();
  assert.equal(resolveInside(dir, 'a.ts', '目标文件'), join(dir, 'a.ts'));
  assert.throws(() => resolveInside(dir, '../outside.ts', '目标文件'), UsageError);
  assert.throws(() => resolveInside(dir, '/etc/passwd', '目标文件'), UsageError);
});

test('precheck: review 目标文件不存在时报错', () => {
  const dir = makeTmpProject();
  assert.throws(() => precheck({ cmd: 'review', positional: ['missing.ts'], scope: [], plan: null, cwd: dir }), /文件不存在/);
  precheck({ cmd: 'review', positional: ['a.ts'], scope: [], plan: null, cwd: dir }); // 不抛
});

test('precheck: --plan 文件不存在时报错', () => {
  const dir = makeTmpProject();
  assert.throws(() => precheck({ cmd: 'implement', positional: ['x'], scope: [], plan: 'missing.md', cwd: dir }), /--plan/);
});

test('precheck: review-diff 非 git 目录报错', () => {
  const dir = makeTmpProject();
  assert.throws(() => precheck({ cmd: 'review-diff', positional: [], scope: [], plan: null, cwd: dir }), /git 仓库/);
});

test('precheck: review-diff 非法 range 报错', () => {
  const dir = makeGitProject();
  assert.throws(() => precheck({ cmd: 'review-diff', positional: ['not-a-ref..HEAD'], scope: [], plan: null, cwd: dir }), /无效的 git range/);
});

test('precheck: review-diff 空 diff 报错，有变更通过', () => {
  const dir = makeGitProject();
  assert.throws(() => precheck({ cmd: 'review-diff', positional: [], scope: [], plan: null, cwd: dir }), /没有可 review 的变更/);
  fsWrite(join(dir, 'a.ts'), 'export const a = 2;\n');
  precheck({ cmd: 'review-diff', positional: [], scope: [], plan: null, cwd: dir }); // 不抛
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL with "precheck is not exported"

- [ ] **Step 3: 写最小实现**

追加到 `bin/kimi-agent.mjs`（顶部补充 import）：

```js
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

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
  for (const s of opts.scope) resolveInside(cwd, s, '--scope 路径');
  if (opts.cmd === 'review-diff') {
    const gitOut = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    let inside = '';
    try { inside = gitOut(['rev-parse', '--is-inside-work-tree']).trim(); } catch { /* fallthrough */ }
    if (inside !== 'true') throw new UsageError('当前目录不是 git 仓库，无法 review diff');
    const range = diffRangeOf(opts);
    let numstat;
    try { numstat = gitOut(['diff', '--numstat', ...range.split(/\s+/)]); }
    catch { throw new UsageError(`无效的 git range: ${range}`); }
    if (!numstat.trim()) throw new UsageError(`范围 ${range} 内没有可 review 的变更（注意：未跟踪的新文件不在 git diff 范围内，请先 git add）`);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（20 个用例）

- [ ] **Step 5: Commit**

```bash
git add bin/kimi-agent.mjs test/helpers.mjs test/unit.test.mjs
git commit -m "feat: 预检查（路径越界 / 文件存在 / git diff 三态）"
```

## Task 6: kimi 执行层 runKimi

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加 `buildKimiArgs`、`runKimi`）
- Create: `test/fixtures/kimi-stub.mjs`
- Test: `test/integration.test.mjs`（新文件）

行为（spec 第 5、8 节）：
- 子进程 API 用 `spawn`（spec 第 5 节写 `execFile`，此为有意偏离：tee 流式转发需要 stream 接口；参数仍是数组、不经 shell，安全性等同）。
- 可执行文件解析：`KIMI_BIN` 环境变量 → PATH 中的 `kimi`。
- `spawn(bin, ['-p', prompt, '-y', (-m model)?], { cwd, stdio: ['ignore','pipe','inherit'] })`。
- tee：stdout 每个 chunk 原样转发到本进程 stdout，同时缓冲；结束后 `Buffer.concat` 一次性 UTF-8 解码（避免多字节截断）。
- 超时：`timeout` 秒后 `SIGKILL`，reject 超时错误（上层 exit 1）。
- `ENOENT`：友好报错提示安装/登录/设置 `KIMI_BIN`。

- [ ] **Step 1: 写 stub fixture**

`test/fixtures/kimi-stub.mjs`：

```js
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
```

- [ ] **Step 2: 写失败测试**

`test/integration.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './helpers.mjs';

const STUB = fileURLToPath(new URL('./fixtures/kimi-stub.mjs', import.meta.url));
chmodSync(STUB, 0o755);

function tmpFile(name) {
  return join(mkdtempSync(join(tmpdir(), 'kimi-agent-it-')), name);
}

test('runKimi: 经 stub 传参正确（-p prompt -y -m model）', async () => {
  const argsFile = tmpFile('args.json');
  const r = await runCli(['run', '你好', '--model', 'k2'], { env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  const args = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.deepEqual(args, ['-p', '你好', '-y', '-m', 'k2']);
  assert.match(r.stdout, /stub 报告/); // stdout 原样转发（含思考行）
  assert.match(r.stdout, /• 思考/);
});

test('runKimi: 透传 stub 非零退出码', async () => {
  const r = await runCli(['run', 'x'], { env: { KIMI_BIN: STUB, STUB_EXIT: '3' } });
  assert.equal(r.code, 3);
});

test('runKimi: 超时 kill，exit 1 且报超时', async () => {
  const r = await runCli(['run', 'x', '--timeout', '1'], { env: { KIMI_BIN: STUB, STUB_SLEEP_MS: '5000' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /超时/);
});

test('runKimi: KIMI_BIN 不存在时 exit 1 且提示安装', async () => {
  const r = await runCli(['run', 'x'], { env: { KIMI_BIN: '/nonexistent/kimi' } });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /找不到 kimi/);
});
```

注意：这些用例依赖 `main` 真正调用 `runKimi`，本任务同时给 `main` 接上最小执行路径（见 Step 4）；`--output`、模板路径在 Task 8 完成。

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（`run` 子命令目前直接 return 0，stub 未被调用）

- [ ] **Step 4: 写最小实现**

追加到 `bin/kimi-agent.mjs`（顶部补充 `import { spawn } from 'node:child_process';`）：

```js
export function buildKimiArgs(prompt, opts) {
  const args = ['-p', prompt, '-y'];
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
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeout * 1000);
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      chunks.push(chunk);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        rejectPromise(new Error(`找不到 kimi 命令（${bin}）。请安装 kimi code CLI 并执行 kimi login，或设置 KIMI_BIN 指向可执行文件。`));
      } else {
        rejectPromise(err);
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectPromise(new Error(`kimi 执行超时（${opts.timeout}s），进程已终止`));
      } else {
        resolvePromise({ code: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8') });
      }
    });
  });
}
```

`main` 接上最小执行路径（暂只支持 `run`；其余子命令**显式报未实现并 exit 2**，避免静默成功，Task 8 替换）：

```js
export async function main(argv) {
  let opts;
  try {
    opts = parseCliArgs(argv);
    precheck(opts);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`错误: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    throw e;
  }
  if (opts.cmd !== 'run') { // Task 8 接入模板子命令后删除本分支
    process.stderr.write(`错误: 子命令 ${opts.cmd} 尚未实现\n`);
    return 2;
  }
  try {
    const { code } = await runKimi(opts.positional[0], opts);
    return code;
  } catch (e) {
    process.stderr.write(`错误: ${e.message}\n`);
    return 1;
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test`
Expected: PASS（24 个用例；超时用例约需 1 秒）

- [ ] **Step 6: Commit**

```bash
git add bin/kimi-agent.mjs test/fixtures/kimi-stub.mjs test/integration.test.mjs
git commit -m "feat: kimi 执行层（tee / 超时 / ENOENT / 退出码透传）"
```

## Task 7: 四个 prompt 模板文件

**Files:**
- Create: `prompts/review-file.md`
- Create: `prompts/review-plan.md`
- Create: `prompts/review-diff.md`
- Create: `prompts/implement.md`
- Test: `test/templates.test.mjs`（新文件）

模板正文即 spec 第 7 节约束的落地；全部用 Task 2 的 `{{VAR}}` / `{{#VAR}}` 语法。

- [ ] **Step 1: 写失败测试**

`test/templates.test.mjs`：

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderTemplate } from '../bin/kimi-agent.mjs';

const tpl = (name) => readFileSync(fileURLToPath(new URL(`../prompts/${name}`, import.meta.url)), 'utf8');

test('review-file: 必填 TARGET_FILE，FOCUS 可选，含只读约束与分级', () => {
  const out = renderTemplate(tpl('review-file.md'), { TARGET_FILE: 'src/a.ts', FOCUS: '并发安全' });
  assert.match(out, /src\/a\.ts/);
  assert.match(out, /并发安全/);
  assert.match(out, /不要修改、创建或删除任何文件/);
  assert.match(out, /Critical \/ Warning \/ Suggestion/);
  assert.match(out, /使用中文/);
  const noFocus = renderTemplate(tpl('review-file.md'), { TARGET_FILE: 'src/a.ts' });
  assert.doesNotMatch(noFocus, /重点关注/);
});

test('review-plan: 必填 PLAN_FILE，SCOPE 可选块', () => {
  const out = renderTemplate(tpl('review-plan.md'), { PLAN_FILE: 'docs/design.md', SCOPE: '- src/\n- test/' });
  assert.match(out, /docs\/design\.md/);
  assert.match(out, /- src\//);
  assert.match(out, /已实现且一致 \/ 已实现但有偏差 \/ 未实现/);
  const noScope = renderTemplate(tpl('review-plan.md'), { PLAN_FILE: 'docs/design.md' });
  assert.match(noScope, /整个仓库/);
  assert.doesNotMatch(noScope, /\{\{/);
});

test('review-diff: DIFF_RANGE 嵌入 git diff 命令，diff 不进 prompt，FOCUS 可选', () => {
  const out = renderTemplate(tpl('review-diff.md'), { DIFF_RANGE: 'main..HEAD', FOCUS: '并发安全' });
  assert.match(out, /git diff main\.\.HEAD/);
  assert.match(out, /不要修改、创建或删除任何文件/);
  assert.match(out, /## 重点关注\n并发安全/);
  const noFocus = renderTemplate(tpl('review-diff.md'), { DIFF_RANGE: 'HEAD' });
  assert.doesNotMatch(noFocus, /重点关注/);
  assert.doesNotMatch(noFocus, /\{\{/);
});

test('implement: TASK 必填，PLAN_FILE/SCOPE 可选，强制 TDD 与验证摘要', () => {
  const out = renderTemplate(tpl('implement.md'), { TASK: '加登录', PLAN_FILE: 'docs/d.md', SCOPE: '- src/' });
  assert.match(out, /加登录/);
  assert.match(out, /docs\/d\.md/);
  assert.match(out, /先编写会失败的测试/);
  assert.match(out, /验证摘要/);
  assert.match(out, /不要提交 git commit/);
  const minimal = renderTemplate(tpl('implement.md'), { TASK: '加登录' });
  assert.doesNotMatch(minimal, /设计文档/);
  assert.doesNotMatch(minimal, /改动范围/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（prompts/*.md 不存在，ENOENT）

- [ ] **Step 3: 写四个模板文件**

`prompts/review-file.md`：

```markdown
你是一名严格的代码评审专家。请 review 以下文件：{{TARGET_FILE}}

## 项目上下文
当前工作目录即项目根目录。开始前请先阅读项目的 README 和 CLAUDE.md（如存在），了解项目约定。

## Review 要求
- 只读分析：不要修改、创建或删除任何文件
- 按严重程度分级：Critical / Warning / Suggestion
- 每条问题给出：位置（文件:行号）、问题描述、修改建议
{{#FOCUS}}
## 重点关注
{{FOCUS}}
{{/FOCUS}}

## 输出格式
使用中文撰写，以 markdown 输出最终 review 报告；未发现问题的维度明确说明“未发现问题”。
```

`prompts/review-plan.md`：

```markdown
你是一名严格的代码评审专家。请对照设计文档 {{PLAN_FILE}} 评审当前代码实现。

## 项目上下文
当前工作目录即项目根目录。开始前请先阅读项目的 README 和 CLAUDE.md（如存在），并通读上述设计文档全文。

## 评审范围
默认评审整个仓库中与设计文档相关的实现；如下方列出具体范围，则以其为准。
{{#SCOPE}}
{{SCOPE}}
{{/SCOPE}}

## Review 要求
- 只读分析：不要修改、创建或删除任何文件
- 逐条对照设计文档的要求，检查实现的完整性与一致性
- 明确归类：已实现且一致 / 已实现但有偏差 / 未实现
- 偏差与缺失按 Critical / Warning / Suggestion 分级，给出位置与修改建议

## 输出格式
使用中文撰写，以 markdown 输出最终 review 报告。
```

`prompts/review-diff.md`：

```markdown
你是一名严格的代码评审专家。请 review 当前项目的代码变更。

## 查看变更
在项目根目录执行 `git diff {{DIFF_RANGE}}`（可先用 `git diff --stat {{DIFF_RANGE}}` 了解全貌）查看本次变更。不要把 diff 之外的历史遗留问题当作本次 review 的重点。

## 项目上下文
当前工作目录即项目根目录。开始前请先阅读项目的 README 和 CLAUDE.md（如存在）。

## Review 要求
- 只读分析：不要修改、创建或删除任何文件
- 聚焦变更本身及其影响面（调用方、测试、文档是否同步）
- 按严重程度分级：Critical / Warning / Suggestion；每条给出位置、描述、建议
{{#FOCUS}}
## 重点关注
{{FOCUS}}
{{/FOCUS}}

## 输出格式
使用中文撰写，以 markdown 输出最终 review 报告；未发现问题的维度明确说明“未发现问题”。
```

`prompts/implement.md`：

```markdown
你是一名严谨的软件工程师。请以 TDD 方式完成以下开发任务。

## 任务
{{TASK}}
{{#PLAN_FILE}}
## 设计文档
实现须遵循设计文档 {{PLAN_FILE}}，开始前请通读该文档。
{{/PLAN_FILE}}
{{#SCOPE}}
## 改动范围
改动尽量限制在以下路径内：
{{SCOPE}}
{{/SCOPE}}

## 工作方式（强制 TDD）
1. 开始前阅读项目的 README 和 CLAUDE.md（如存在），遵循项目现有代码风格与测试框架
2. 先编写会失败的测试，运行确认失败
3. 编写最小实现使测试通过
4. 运行完整测试套件，确保没有破坏既有测试
5. 不要提交 git commit，把所有改动留在工作区

## 输出格式
使用中文撰写总结报告（markdown）。报告末尾必须包含「验证摘要」一节：列出实际执行的测试命令及通过/失败计数。
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（28 个用例）

- [ ] **Step 5: Commit**

```bash
git add prompts/ test/templates.test.mjs
git commit -m "feat: 四个固定 prompt 模板及内容断言"
```

## Task 8: main 整合 + --dry-run + --output + 集成测试

**Files:**
- Modify: `bin/kimi-agent.mjs`（追加 `buildVars`、`buildPrompt`，补全 `main`）
- Test: `test/integration.test.mjs`（追加用例）

变量装配（spec 第 6、7 节）：
- `review` → `TARGET_FILE`（用户传入的原样路径，kimi 以 cwd 为根解析）、`FOCUS`。
- `review-plan` → `PLAN_FILE`、`SCOPE`（多值拼为 `- <路径>` 换行列表）。
- `review-diff` → `DIFF_RANGE`（`diffRangeOf(opts)`，默认 `HEAD`）、`FOCUS`。
- `implement` → `TASK`、`SCOPE`、`PLAN_FILE`（来自 `--plan`）。
- `run` → 不套模板，原样透传。

- [ ] **Step 1: 写失败测试**

追加到 `test/integration.test.mjs`：

```js
import { makeTmpProject, makeGitProject } from './helpers.mjs';

test('review: 最终 prompt 含模板骨架与目标文件', async () => {
  const dir = makeTmpProject();
  const argsFile = tmpFile('args.json');
  const r = await runCli(['review', 'a.ts', '--focus', '并发'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  const [pFlag, prompt, yFlag] = JSON.parse(readFileSync(argsFile, 'utf8'));
  assert.equal(pFlag, '-p');
  assert.equal(yFlag, '-y');
  assert.match(prompt, /请 review 以下文件：a\.ts/);
  assert.match(prompt, /## 重点关注\n并发/);
  assert.match(prompt, /不要修改、创建或删除任何文件/);
});

test('review-diff: 默认 DIFF_RANGE=HEAD 进入 prompt', async () => {
  const dir = makeGitProject();
  writeFileSync(join(dir, 'a.ts'), 'export const a = 2;\n');
  const argsFile = tmpFile('args.json');
  const r = await runCli(['review-diff'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  const prompt = JSON.parse(readFileSync(argsFile, 'utf8'))[1];
  assert.match(prompt, /git diff HEAD/);
});

test('implement: TASK/SCOPE/PLAN_FILE 全部进入 prompt', async () => {
  const dir = makeTmpProject();
  writeFileSync(join(dir, 'design.md'), '# d\n');
  const argsFile = tmpFile('args.json');
  const r = await runCli(['implement', '加登录', '--scope', 'src/', '--plan', 'design.md'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  const prompt = JSON.parse(readFileSync(argsFile, 'utf8'))[1];
  assert.match(prompt, /## 任务\n加登录/);
  assert.match(prompt, /design\.md/);
  assert.match(prompt, /- src\//);
  assert.match(prompt, /验证摘要/);
});

test('--output: stdout 原样、落盘已过滤', async () => {
  const dir = makeTmpProject();
  const r = await runCli(['review', 'a.ts', '--output', 'report.md'], { cwd: dir, env: { KIMI_BIN: STUB } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /• 思考/); // stdout 不过滤
  const saved = readFileSync(join(dir, 'report.md'), 'utf8');
  assert.doesNotMatch(saved, /• 思考/);
  assert.doesNotMatch(saved, /To resume this session/);
  assert.match(saved, /stub 报告/);
});

test('--dry-run: 打印 prompt 与命令行，不调用 kimi', async () => {
  const dir = makeTmpProject();
  const argsFile = tmpFile('args.json');
  const r = await runCli(['review', 'a.ts', '--dry-run'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--- prompt ---/);
  assert.match(r.stdout, /请 review 以下文件/);
  assert.throws(() => readFileSync(argsFile), /ENOENT/); // stub 未被调用
});

test('--output 路径越界拒绝', async () => {
  const dir = makeTmpProject();
  const r = await runCli(['review', 'a.ts', '--output', '../evil.md'], { cwd: dir, env: { KIMI_BIN: STUB } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /超出工作目录/);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test`
Expected: FAIL（非 run 子命令 main 直接 return 0，stub 未收到调用）

- [ ] **Step 3: 写实现**

追加到 `bin/kimi-agent.mjs`（顶部补充 `import { readFileSync, writeFileSync } from 'node:fs';`、`import { dirname } from 'node:path';`、`import { fileURLToPath } from 'node:url';`）：

```js
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
```

`main` 补全为最终形态（替换 Task 6 的临时版本）：

```js
export async function main(argv) {
  let opts;
  let prompt;
  let outputAbs = null;
  try {
    opts = parseCliArgs(argv);
    precheck(opts);
    prompt = buildPrompt(opts);
    if (opts.output) outputAbs = resolveInside(opts.cwd, opts.output, '--output 文件');
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
    process.stderr.write(`错误: ${e.message}\n`);
    return 1;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test`
Expected: PASS（34 个用例）

- [ ] **Step 5: Commit**

```bash
git add bin/kimi-agent.mjs test/integration.test.mjs
git commit -m "feat: main 全流程整合（模板子命令 / --dry-run / --output）"
```

## Task 9: SKILL.md + README + 手动冒烟

**Files:**
- Create: `SKILL.md`
- Modify: `README.md`（替换占位内容）

无自动化测试；验收方式为 `--dry-run` 检查 + 一次真实 kimi 冒烟。

- [ ] **Step 1: 写 SKILL.md**

```markdown
---
name: kimi-agent
version: 0.1.0
description: "调用 kimi code CLI 执行代码/文档 review 和 TDD 开发。支持单文件 review、plan-based review、diff review、TDD 实现与自由任务。仅在用户明确提到 'kimi' 且意图为 review/实现/编码任务时触发，例如 '用kimi review这个文件'、'让kimi实现登录功能'。浏览器/网页类请求不归本 skill（走 kimi-webbridge）。"
---

# kimi-agent

## 触发条件

**仅当用户明确提到 "kimi" 且意图为 review/实现/编码任务时触发**，例如：

- "用kimi review一下 src/auth.ts"
- "让kimi对照 docs/design.md 检查实现"
- "用kimi检查一下这个PR / 这次改动"
- "让kimi实现登录功能"
- "让kimi随便看看这个项目"

**不触发**：

- 未提 kimi 的 review/开发请求 → Claude 自行处理
- 浏览器、网页、截图类请求 → 归 kimi-webbridge skill

## 调用方式

用本 skill 的基目录（skill 加载时注入的 "Base directory" 行）拼出脚本绝对路径，不依赖 cwd：

​```bash
node <skill基目录>/bin/kimi-agent.mjs <子命令> [参数...]
​```

## 意图 → 子命令映射

| 用户说法 | 子命令 |
|---------|--------|
| review 某个文件/文档 | `review <file>` |
| 对照设计文档/plan 检查实现 | `review-plan <plan>` |
| review 这个 PR / 这次改动 / 提交前检查 | `review-diff [<range>]` |
| 实现/开发/加功能/加测试 | `implement "<需求>"` |
| 其他明确指名 kimi 的编码任务 | `run "<prompt>"` |

模糊意图默认路由：能对上前四行的优先用模板化子命令，对不上的才落到 `run`。

## 示例

​```bash
node <skill基目录>/bin/kimi-agent.mjs review src/auth.ts --focus "并发安全"
node <skill基目录>/bin/kimi-agent.mjs review-plan docs/design.md --scope src/ --output review.md
node <skill基目录>/bin/kimi-agent.mjs review-diff main..HEAD
node <skill基目录>/bin/kimi-agent.mjs implement "给 auth.ts 加 JWT 验证" --plan docs/design.md
node <skill基目录>/bin/kimi-agent.mjs run "总结这个项目的架构"
node <skill基目录>/bin/kimi-agent.mjs review src/auth.ts --dry-run   # 调试：只看 prompt
​```

## 风险提示

- `implement` 会直接修改仓库文件（kimi 以 `-y` 全自动运行，改动留在工作区、不 commit）
- `implement` 成功判定：exit 0 **且**报告末尾含「验证摘要」（测试命令与通过/失败计数）；缺摘要视为"实现未经验证"，须向用户如实说明
- review 类的"只读"是 prompt 级软约束，无技术强制；异常改动靠 git 兜底
- `run` 仅用于四个模板覆盖不了的场景

## 配置

- 依赖已安装并登录的 kimi code CLI（`kimi login`）
- `KIMI_BIN` 环境变量可覆盖 kimi 可执行文件路径
- `--model` 透传 kimi 的模型别名
```

注意：上方代码块内的 ​``` 转义仅为计划文档嵌套所需，落盘 SKILL.md 时写正常的三反引号。

- [ ] **Step 2: 写 README.md**

```markdown
# claude-kimi-agent-skill

Claude Code skill：通过固定 prompt 模板调用 kimi code CLI，完成 review 与 TDD 开发任务。

## 特性

- **review** — 单文件/文档 review（Critical/Warning/Suggestion 分级）
- **review-plan** — 对照设计文档评审代码实现
- **review-diff** — review 未提交变更或任意 git range（diff 由 kimi 自行查看，不撑爆 prompt）
- **implement** — 强制 TDD 的功能实现（改动留在工作区，不自动 commit）
- **run** — 自由任务透传
- prompt 拼装 100% 由代码完成（模板 + 变量替换），不依赖模型即兴发挥

## 前置条件

1. Node.js ≥ 20
2. 已安装并登录 kimi code CLI（`kimi login`），或设置 `KIMI_BIN`

## 用法

见 `SKILL.md` 的示例一节；所有子命令支持 `--model`、`--timeout <sec>`（默认 600）、`--cwd <dir>`、`--dry-run`。

review 类子命令支持 `--output <file>` 把过滤后的报告落盘（stdout 始终原样转发）。

## 开发

​```bash
npm test        # node:test，无外部依赖
​```

## Troubleshooting

- **找不到 kimi 命令**：确认 `kimi` 在 PATH 中或设置 `KIMI_BIN`
- **review-diff 报"没有可 review 的变更"**：确认工作区有未提交改动，或显式传 range（如 `main..HEAD`、`--cached`）
- **超大仓库 diff**：kimi 自行执行 git diff 查看变更；必要时用 range 缩小范围
- **超时**：默认 600s，长任务加 `--timeout 1800`
```

（同样注意嵌套代码块转义。）

- [ ] **Step 3: dry-run 验收（五种子命令各跑一次）**

```bash
node bin/kimi-agent.mjs review README.md --dry-run
node bin/kimi-agent.mjs review README.md --focus "结构" --dry-run
node bin/kimi-agent.mjs review-plan docs/superpowers/specs/2026-07-03-kimi-agent-skill-design.md --scope bin/ --dry-run
node bin/kimi-agent.mjs review-diff --dry-run          # 需工作区有未提交变更，否则预检查报错即为正确行为
node bin/kimi-agent.mjs implement "示例任务" --dry-run
node bin/kimi-agent.mjs run "示例prompt" --dry-run
```

Expected: 每次都打印 kimi 命令行与完整渲染后的 prompt，无 `{{` 残留；可选块随参数有无正确展开/删除。

另注（引用 spec 第 7 节）：`implement` 的成功判定 CLI 只透传 kimi 退出码；**报告是否含「验证摘要」由调用方（Claude）检查**，缺摘要应视为"实现未经验证"。此规则写入 SKILL.md 风险提示之后的调用约定中。

- [ ] **Step 4: 真实冒烟（需要已登录的 kimi）**

```bash
node bin/kimi-agent.mjs run "回复'ok'即可，不要做任何其他事" --timeout 120
```

Expected: exit 0，stdout 出现 kimi 回复。若输出格式与 `filterReport` 假设不符（思考行前缀、resume 尾行变化），用真实样本更新 `test/fixtures/kimi-stub.mjs` 与过滤规则。

- [ ] **Step 5: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: SKILL.md 与 README"
```
