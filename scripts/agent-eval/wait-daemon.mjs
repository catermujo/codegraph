#!/usr/bin/env node
// Wait until a CodeGraph daemon for <target> is listening.
// Usage: node wait-daemon.mjs <target> <dist/bin/codegraph.js> [timeout-ms]
// The build decides where the socket goes: a long target path moves it from
// .codegraph/daemon.sock to the temp dir, so ask the build that runs the daemon.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

const [target, bin, timeoutMs = '15000'] = process.argv.slice(2);
if (!target || !bin) {
  process.stderr.write('Usage: node wait-daemon.mjs <target> <dist/bin/codegraph.js> [timeout-ms]\n');
  process.exit(2);
}

let paths;
try {
  const { getDaemonSocketCandidates } = createRequire(import.meta.url)(resolve(dirname(bin), '..', 'mcp', 'daemon-paths.js'));
  paths = getDaemonSocketCandidates(target);
} catch {
  // Builds older than the temp-dir fallback always bind inside the project.
  paths = [join(target, '.codegraph', 'daemon.sock')];
}

const deadline = Date.now() + Number(timeoutMs);
const timer = setInterval(() => {
  if (paths.some((path) => existsSync(path))) {
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    clearInterval(timer);
    process.exit(1);
  }
}, 100);
