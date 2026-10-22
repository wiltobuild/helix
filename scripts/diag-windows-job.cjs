// TEMPORARY diagnostic for the windows-latest harness hang. Not part of the product.
// Launches packages/harness/src/windows-job.ps1 the same way spawnExecutable does,
// sends one line, and prints every stdout/stderr byte with timestamps.
const { spawn } = require('node:child_process');
const path = require('node:path');

const wrapper = path.resolve(__dirname, '../packages/harness/src/windows-job.ps1');
const child = 'process.stdin.on("data",d=>{process.stdout.write("pong:"+d);process.exit(0)});process.stdout.write("ready\\n")';
const scenarios = [
  { name: 'echo child', bin: process.execPath, args: `-e "${child.replace(/"/g, '\\"')}"`, input: 'ping\n' },
  { name: 'version-only child', bin: process.execPath, args: '--version', input: null },
];

function run(scenario) {
  return new Promise((resolve) => {
    const start = Date.now();
    const t = () => `+${String(Date.now() - start).padStart(5)}ms`;
    const launch = Buffer.from(
      JSON.stringify({ bin: scenario.bin, arguments: scenario.args, cwd: process.cwd() }),
    ).toString('base64');
    console.log(`\n=== ${scenario.name}`);
    const ps = spawn(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', wrapper, '-Launch', launch],
      { stdio: 'pipe', windowsHide: true, env: { ...process.env, HELIX_DEBUG_PROCESS: '1' } },
    );
    console.log(`${t()} spawned powershell pid=${ps.pid}`);
    ps.stdout.on('data', (d) => console.log(`${t()} STDOUT ${JSON.stringify(d.toString())}`));
    ps.stderr.on('data', (d) => console.log(`${t()} STDERR ${JSON.stringify(d.toString())}`));
    if (scenario.input) {
      setTimeout(() => {
        console.log(`${t()} writing stdin`);
        ps.stdin.write(scenario.input);
      }, 3000);
    }
    const timer = setTimeout(() => {
      console.log(`${t()} TIMEOUT after 40s; killing`);
      ps.kill();
    }, 40000);
    ps.on('exit', (code, signal) => {
      clearTimeout(timer);
      console.log(`${t()} exit code=${code} signal=${signal}`);
      resolve();
    });
  });
}

(async () => {
  for (const scenario of scenarios) await run(scenario);
})();
