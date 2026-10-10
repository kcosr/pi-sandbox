/**
 * Runs once per native smolvm exec, using Node from the selected guest image.
 * Keep this self-contained CommonJS for Node 18+. The wrapper owns output pipes
 * so upstream's immediate post-exit drain cannot truncate Pi's 100 ms idle
 * period. There is no additional resident worker or process supervisor.
 */
export const SMOLVM_GUEST_COMMAND = String.raw`
const { spawn } = require('node:child_process');
const request = JSON.parse(Buffer.from(process.argv[1], 'base64'));
const child = spawn(request.argv[0], request.argv.slice(1), {
  cwd: request.cwd,
  env: {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/root',
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    ...request.environment,
  },
  stdio: ['inherit', 'pipe', 'pipe'],
});
let exitCode;
let finished = false;
let idleTimer;
const ended = new Set();
const blocked = new Set();
const streams = [[child.stdout, process.stdout], [child.stderr, process.stderr]];

function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  for (const [source] of streams) source.destroy();
  // An empty write's callback follows all previously forwarded bytes. Exit
  // explicitly only after both destinations have flushed, including when a
  // background descendant kept a source pipe open beyond the idle deadline.
  let remaining = streams.length;
  for (const [, destination] of streams) {
    destination.write('', () => {
      if (--remaining === 0) process.exit(code);
    });
  }
}

function scheduleCompletion(reset = false) {
  if (reset || blocked.size) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  if (finished || exitCode === undefined) return;
  if (ended.size === streams.length) return finish(exitCode);
  // A paused source is waiting for transport capacity, not idle. Otherwise a
  // slow host could lose unread output merely because forwarding was paused.
  if (blocked.size === 0 && idleTimer === undefined) {
    idleTimer = setTimeout(() => finish(exitCode), 100);
  }
}

for (const [source, destination] of streams) {
  destination.on('error', () => process.exit(126));
  source.on('error', () => finish(126));
  source.on('data', (chunk) => {
    if (finished) return;
    if (!destination.write(chunk)) {
      source.pause();
      blocked.add(source);
      destination.once('drain', () => {
        blocked.delete(source);
        if (finished) return;
        source.resume();
        scheduleCompletion(true);
      });
    }
    scheduleCompletion(true);
  });
  source.once('end', () => {
    ended.add(source);
    scheduleCompletion();
  });
}
child.once('error', () => finish(126));
child.once('exit', (code, signal) => {
  exitCode = code ?? (signal ? 137 : 126);
  scheduleCompletion(true);
});
`;
