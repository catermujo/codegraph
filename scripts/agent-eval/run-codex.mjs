#!/usr/bin/env node
import { openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const [configFile, target, task, stem] = process.argv.slice(2);
if (!stem) throw new Error('usage: run-codex.mjs <mcp-json> <target> <task> <output-stem>');
const servers = JSON.parse(readFileSync(configFile, 'utf8')).mcpServers;
const toml = (value) => Array.isArray(value) ? `[${value.map(toml).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
    : JSON.stringify(value);
const model = process.env.MODEL || 'gpt-5.6-luna';
const effort = process.env.EFFORT || 'high';
const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--model', model, '-c', `model_reasoning_effort=${toml(effort)}`,
  '-c', 'approval_policy="never"', '-c', 'project_doc_max_bytes=0', '-c', `mcp_servers=${toml(servers)}`,
  ...['apps', 'plugins', 'browser_use', 'computer_use', 'multi_agent'].flatMap((feature) => ['--disable', feature]),
  '--json', '-C', target, '-o', `${stem}.answer.md`,
  `${task}\nRead-only. Use MCP for CodeGraph. Never invoke the CodeGraph CLI, including through node or npx.`];
const stdout = openSync(`${stem}.jsonl`, 'w');
const stderr = openSync(`${stem}.err`, 'w');
const started = Date.now();
const result = spawnSync('codex', args, { stdio: ['ignore', stdout, stderr], timeout: 600_000 });
closeSync(stdout);
closeSync(stderr);
writeFileSync(`${stem}.meta.json`, JSON.stringify({ model, effort, seconds: (Date.now() - started) / 1000,
  exitCode: result.status, error: result.error?.message ?? null, args }, null, 2));
if (result.error || result.status !== 0) {
  throw new Error(`Codex failed: ${result.error?.message || result.status}. Read ${stem}.err`);
}
