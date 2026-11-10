import { spawn } from 'node:child_process';
import { openSync, writeSync, closeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Запустите проверку командой npm run check.');
  process.exit(1);
}
const logPath = fileURLToPath(new URL('../check.log', import.meta.url));
const log = openSync(logPath, 'w');
const started = performance.now();
const clean = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');

async function run(step, label) {
  const time = performance.now();
  writeSync(log, `\n--- ${step} ---\n`);
  let tail = '';
  const child = spawn(process.execPath, [npmCli, 'run', step], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      writeSync(log, chunk);
      tail = (tail + chunk).slice(-32 * 1024);
    });
  }
  const code = await new Promise((resolve) => {
    child.once('error', (error) => { writeSync(log, `${error.message}\n`); resolve(1); });
    child.once('close', (exitCode) => resolve(exitCode ?? 1));
  });
  const seconds = ((performance.now() - time) / 1000).toFixed(1);
  const output = clean(tail);
  const tests = step === 'test' ? output.match(/Tests\s+([^\r\n]+)/)?.[1].trim() : '';
  console.log(`${code === 0 ? 'OK' : 'FAIL'} ${label} (${seconds} с)${tests ? `: ${tests}` : ''}`);
  if (code !== 0) {
    console.error(output.trim().split(/\r?\n/).slice(-30).join('\n'));
    console.error(`Полный журнал: ${logPath}`);
  }
  return code;
}

try {
  for (const [step, label] of [['typecheck', 'Типы'], ['test', 'Тесты'], ['build', 'Сборка']]) {
    const code = await run(step, label);
    if (code !== 0) { process.exitCode = code; break; }
  }
  if (!process.exitCode) console.log(`Все проверки пройдены за ${((performance.now() - started) / 1000).toFixed(1)} с. Журнал: check.log`);
} finally {
  closeSync(log);
}
