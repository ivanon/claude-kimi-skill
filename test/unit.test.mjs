import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync as fsWrite } from 'node:fs';
import { join } from 'node:path';
import { runCli, makeTmpProject, makeGitProject } from './helpers.mjs';
import { renderTemplate, UsageError, parseCliArgs, filterReport, precheck, resolveInside } from '../bin/kimi-agent.mjs';

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

test('parseCliArgs: 选项按子命令白名单校验', () => {
  assert.throws(() => parseCliArgs(['implement', 'x', '--focus', 'f']), (e) => e instanceof UsageError && /--focus 不适用于子命令 implement/.test(e.message));
  assert.throws(() => parseCliArgs(['review', 'a.ts', '--scope', 's']), UsageError);
  assert.throws(() => parseCliArgs(['run', 'x', '--plan', 'p']), UsageError);
  assert.throws(() => parseCliArgs(['review-diff', '--scope', 's']), UsageError);
  // 合法组合不受影响
  parseCliArgs(['review-diff', '--focus', 'f']);
  parseCliArgs(['run', 'x', '--output', 'r.md']);
});

// 依据 kimi -p 真实输出校准（2026-07-03 冒烟样本）：
// 每条消息渲染为 "• " 开头的块，续行缩进 2 空格；最后一个块是最终回复；
// resume 提示可能直接粘在正文最后一个字符后（无换行）。
test('filterReport: 取最后一个 bullet 块为报告，去前缀与缩进，删 resume', () => {
  const raw = [
    '• 思考：The user wants a review. I should analyze the file.',
    '',
    '• # review 报告',
    '',
    '  - 正常列表项',
    '  正文中包含 • 字符但不在行首To resume this session: kimi -r session_abc123',
    '',
    '',
  ].join('\n');
  const out = filterReport(raw);
  assert.doesNotMatch(out, /思考：/);
  assert.doesNotMatch(out, /To resume this session/);
  assert.match(out, /^# review 报告/);
  assert.match(out, /^- 正常列表项/m);
  assert.match(out, /^正文中包含 • 字符但不在行首$/m);
  assert.ok(out.endsWith('\n') && !out.endsWith('\n\n'));
});

test('filterReport: 无 bullet 块时保留全文（仅删 resume 与多余空行）', () => {
  const raw = '# 报告\n\n\n\n正文\nTo resume this session: kimi -r session_x\n';
  const out = filterReport(raw);
  assert.doesNotMatch(out, /\n{3,}/);
  assert.doesNotMatch(out, /To resume/);
  assert.match(out, /# 报告/);
  assert.match(out, /正文/);
});

test('filterReport: 单一 bullet 块（回复本身）保留内容', () => {
  const out = filterReport('• ok\n\n');
  assert.equal(out, 'ok\n');
});

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

test('precheck: review-diff 非法 range 报错，且错误信息附带 git stderr 细节', () => {
  const dir = makeGitProject();
  assert.throws(
    () => precheck({ cmd: 'review-diff', positional: ['not-a-ref..HEAD'], scope: [], plan: null, cwd: dir }),
    (e) => e instanceof UsageError && /无效的 git range/.test(e.message) && e.message.includes('（')
  );
});

test('precheck: review-diff 空 diff 报错，有变更通过', () => {
  const dir = makeGitProject();
  assert.throws(() => precheck({ cmd: 'review-diff', positional: [], scope: [], plan: null, cwd: dir }), /没有可 review 的变更/);
  fsWrite(join(dir, 'a.ts'), 'export const a = 2;\n');
  precheck({ cmd: 'review-diff', positional: [], scope: [], plan: null, cwd: dir }); // 不抛
});
