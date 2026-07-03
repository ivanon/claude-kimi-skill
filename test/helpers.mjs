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
