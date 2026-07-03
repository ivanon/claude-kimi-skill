import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.mjs';
import { renderTemplate, UsageError, parseCliArgs } from '../bin/kimi-agent.mjs';

test('未知子命令：exit 2 且 stderr 含用法', async () => {
  const r = await runCli(['nonsense']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知子命令/);
  assert.match(r.stderr, /用法/);
});

test('无参数：exit 2 且 stderr 含用法', async () => {
  const r = await runCli([]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /未知子命令/);
  assert.match(r.stderr, /用法/);
});

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

test('renderTemplate: CRLF 模板归一化后可选块正常工作', () => {
  const withValue = renderTemplate('{{#OPT}}\r\n内容\r\n{{/OPT}}\r\n尾部', { OPT: 'x' });
  assert.match(withValue, /内容/);
  assert.doesNotMatch(withValue, /\{\{/);
  const noValue = renderTemplate('{{#OPT}}\r\n内容\r\n{{/OPT}}\r\n尾部', {});
  assert.doesNotMatch(noValue, /内容/);
  assert.doesNotMatch(noValue, /\{\{/);
});

test('renderTemplate: 值含 $ 特殊字符时原样穿透', () => {
  assert.equal(renderTemplate('值: {{V}}', { V: '$& $1 $$' }), '值: $& $1 $$');
});

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

test('parseCliArgs: review-diff 下已知选项仍按选项解析', () => {
  const o = parseCliArgs(['review-diff', '--focus', 'perf']);
  assert.equal(o.focus, 'perf');
  assert.deepEqual(o.positional, []);
});

test('parseCliArgs: 重复选项后者覆盖前者', () => {
  const o = parseCliArgs(['review', 'a.ts', '--focus', 'first', '--focus', 'second']);
  assert.equal(o.focus, 'second');
});

test('parseCliArgs: -- 终止选项解析，--cwd 空值报错', () => {
  const o = parseCliArgs(['run', '--', '--not-an-option']);
  assert.deepEqual(o.positional, ['--not-an-option']);
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--cwd', '']), UsageError);
});
