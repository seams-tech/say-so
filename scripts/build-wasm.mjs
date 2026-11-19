import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawWasm = resolve(root, 'target/wasm32-unknown-unknown/release/sayso_wasm.wasm');
const outDir = resolve(root, 'workers/verifier/src/wasm');
const outWasm = resolve(outDir, 'sayso_wasm.wasm');

execFileSync('cargo', ['build', '-p', 'sayso-wasm', '--target', 'wasm32-unknown-unknown', '--release'], {
  cwd: root,
  stdio: 'inherit',
});

mkdirSync(outDir, { recursive: true });

try {
  execFileSync(
    'wasm-opt',
    ['-Oz', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '--enable-sign-ext', rawWasm, '-o', outWasm],
    {
      cwd: root,
      stdio: 'inherit',
    },
  );
} catch {
  copyFileSync(rawWasm, outWasm);
}

const bytes = statSync(outWasm).size;
console.log(`sayso_wasm.wasm ready: ${bytes.toLocaleString()} bytes -> ${outWasm}`);
