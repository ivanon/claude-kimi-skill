import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli, makeTmpProject, makeGitProject } from './helpers.mjs';

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

test('--output 指向已存在目录时 exit 2 且提示目录', async () => {
  const dir = makeTmpProject();
  mkdirSync(join(dir, 'outdir'));
  const argsFile = tmpFile('args.json');
  const r = await runCli(['review', 'a.ts', '--output', 'outdir'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /是一个目录/);
  assert.throws(() => readFileSync(argsFile), /ENOENT/); // 调 kimi 前快速失败
});

test('review-plan: 端到端 prompt 含设计文档与 scope', async () => {
  const dir = makeTmpProject();
  writeFileSync(join(dir, 'design.md'), '# d\n');
  const argsFile = tmpFile('args.json');
  const r = await runCli(['review-plan', 'design.md', '--scope', 'src/'], { cwd: dir, env: { KIMI_BIN: STUB, STUB_ARGS_FILE: argsFile } });
  assert.equal(r.code, 0);
  const prompt = JSON.parse(readFileSync(argsFile, 'utf8'))[1];
  assert.match(prompt, /design\.md/);
  assert.match(prompt, /- src\//);
  assert.match(prompt, /已实现且一致/);
});
