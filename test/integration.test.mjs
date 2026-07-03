import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
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

// STUB_SLEEP_MS=5000 远大于 1s timeout + 进程启动开销，避免慢 CI 下 flaky
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
