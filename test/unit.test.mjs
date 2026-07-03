import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from './helpers.mjs';
import { renderTemplate, UsageError } from '../bin/kimi-agent.mjs';

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
