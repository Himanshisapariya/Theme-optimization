const { spawn } = require('node:child_process');

function start(name, args, options = {}) {
  const child = spawn(name, args, {
    stdio: 'inherit',
    shell: true,
    ...options
  });

  child.on('exit', (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });

  return child;
}

const backend = start('npm', ['run', 'dev', '--workspace', 'backend']);
const frontend = start('npm', ['run', 'dev', '--workspace', 'frontend']);

function shutdown(signal) {
  backend.kill(signal);
  frontend.kill(signal);
  process.exit();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
