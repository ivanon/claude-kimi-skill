import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

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
