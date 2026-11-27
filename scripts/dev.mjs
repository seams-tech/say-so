import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const devVarsPath = resolve(root, 'workers/verifier/.dev.vars');
const devVars = existsSync(devVarsPath) ? readFileSync(devVarsPath, 'utf8') : '';
const isMock = /^\s*SAYSO_DEV_MOCK\s*=\s*true\s*$/im.test(devVars);

const workerArgs = ['--filter', '@seams/sayso-verifier-worker', 'exec', 'wrangler', 'dev', '--port', '8787'];
if (isMock) workerArgs.push('--local');

console.log(
  `Starting SaySo Worker (:8787${isMock ? ', local offline mock mode' : ''}) and Demo (:5179)...`,
);

const worker = spawn('pnpm', workerArgs, { cwd: root, stdio: 'inherit' });
const demo = spawn('pnpm', ['--filter', '@seams/sayso-demo', 'dev'], { cwd: root, stdio: 'inherit' });

let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.kill('SIGTERM');
  demo.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
worker.on('exit', (code) => shutdown(code ?? 0));
demo.on('exit', (code) => shutdown(code ?? 0));
