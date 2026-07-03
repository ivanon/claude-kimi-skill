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
  assert.match(r.stderr, /未知子命令/);
  assert.match(r.stderr, /用法/);
});
