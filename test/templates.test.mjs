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
  assert.match(out, /不要修改、创建或删除任何文件/);
  assert.match(out, /使用中文/);
  const noScope = renderTemplate(tpl('review-plan.md'), { PLAN_FILE: 'docs/design.md' });
  assert.match(noScope, /整个仓库/);
  assert.doesNotMatch(noScope, /\{\{/);
});

test('review-diff: DIFF_RANGE 嵌入 git diff 命令，diff 不进 prompt，FOCUS 可选', () => {
  const out = renderTemplate(tpl('review-diff.md'), { DIFF_RANGE: 'main..HEAD', FOCUS: '并发安全' });
  assert.match(out, /git diff main\.\.HEAD/);
  assert.match(out, /不要修改、创建或删除任何文件/);
  assert.match(out, /## 重点关注\n并发安全/);
  assert.match(out, /使用中文/);
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
