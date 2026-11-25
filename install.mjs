#!/usr/bin/env node
// Installs the dependencies and registers the Jira MCP server with Claude Code
// (user scope) and, optionally, VS Code. Works on macOS, Linux and Windows.
//
//   node install.mjs            interactive
//   node install.mjs --dry-run  show what would happen, change nothing
//
// Answers can be preset with environment variables (JIRA_TOKEN, JIRA_PROJECT, ...);
// a preset variable is used as is and not asked for.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'jira-onprem';
const JIRA_BASE_URL = 'https://jira.essent.nl/jira';
const OPTIONAL_VARS = [
  ['JIRA_PROJECT', 'Default project key (e.g. TI)'],
  ['JIRA_AGILE_TEAM', 'Default Agile Team'],
  ['JIRA_AGILE_RELEASE_TRAIN', 'Default Agile Release Train'],
  ['JIRA_INVOLVED_APPLICATIONS', 'Default Involved Applications'],
  ['JIRA_LABELS', 'Default labels, comma-separated'],
];

const isWindows = process.platform === 'win32';
const dryRun = process.argv.includes('--dry-run');
const repoDir = dirname(fileURLToPath(import.meta.url));
const serverPath = join(repoDir, 'src', 'jira-mcp.mts');

const fail = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

// --- Node version -------------------------------------------------------------
// Node runs the .mts server directly; type stripping is on by default from 22.18.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  fail(`Node 22.18 or newer is needed (you have ${process.versions.node}).`);
}

// --- Prompts ------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
let muted = false;
rl._writeToOutput = (text) => {
  if (!muted) rl.output.write(text);
};
// Lines are queued as they arrive, so piped input works too; at end of input
// every remaining question gets an empty answer.
const lines = [];
const waiting = [];
let inputClosed = false;
rl.on('line', (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on('close', () => {
  inputClosed = true;
  while (waiting.length) waiting.shift()('');
});
const nextLine = () =>
  lines.length ? Promise.resolve(lines.shift()) : inputClosed ? Promise.resolve('') : new Promise((r) => waiting.push(r));

async function ask(question, { secret = false } = {}) {
  process.stdout.write(question);
  muted = secret;
  const answer = await nextLine();
  muted = false;
  if (secret || !process.stdin.isTTY) process.stdout.write('\n');
  return answer.trim();
}

// --- Running commands -----------------------------------------------------------
// On Windows, npm and an npm-installed claude are .cmd shims, which Node can only
// start through cmd.exe. Arguments are quoted for cmd.exe in that case.
const quoteForCmd = (arg) => {
  if (/["%]/.test(arg)) fail(`Can't safely pass a value containing " or % through cmd.exe: ${arg}`);
  return /^[\w.\/\\:=,+-]+$/.test(arg) ? arg : `"${arg}"`;
};

function run(command, args, { display = args, allowFail = false } = {}) {
  console.log(`  $ ${command} ${display.join(' ')}`);
  if (dryRun) return { status: 0 };
  let result = spawnSync(command, args, { stdio: 'inherit', cwd: repoDir });
  if (isWindows && result.error && ['ENOENT', 'EINVAL'].includes(result.error.code)) {
    result = spawnSync([command, ...args].map(quoteForCmd).join(' '), {
      stdio: 'inherit',
      cwd: repoDir,
      shell: true,
    });
  }
  if (result.error?.code === 'ENOENT') fail(`'${command}' was not found on your PATH.`);
  if (result.status !== 0 && !allowFail) fail(`'${command} ${display.join(' ')}' failed.`);
  return result;
}

const commandExists = (command) => {
  const result = spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore' });
  return result.status === 0;
};

// --- VS Code --------------------------------------------------------------------
function vscodeMcpPath() {
  if (isWindows) return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
  return join(homedir(), '.config', 'Code', 'User', 'mcp.json');
}

function addToVscode(env) {
  const file = vscodeMcpPath();
  const entry = { type: 'stdio', command: 'node', args: [serverPath], env };
  let config = { servers: {} };
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // mcp.json may contain comments, which JSON.parse can't read; don't risk breaking it.
      console.log(`  ${file} couldn't be parsed (it may contain comments). Add this under "servers" yourself:`);
      console.log(JSON.stringify({ [SERVER_NAME]: { ...entry, env: { ...env, JIRA_TOKEN: '<your token>' } } }, null, 2));
      return;
    }
  }
  config.servers ??= {};
  config.servers[SERVER_NAME] = entry;
  console.log(`  writing "${SERVER_NAME}" to ${file}`);
  if (dryRun) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

// --- Main -----------------------------------------------------------------------
console.log(`Jira MCP server installer${dryRun ? ' (dry run: nothing is changed)' : ''}\n`);

console.log('1. Installing dependencies');
run('npm', ['install', '--no-fund', '--no-audit']);

console.log('\n2. Jira settings');
const env = {};
env.JIRA_TOKEN =
  process.env.JIRA_TOKEN ||
  (await ask('Jira personal access token (Jira avatar → Profile → Personal access tokens): ', { secret: true }));
if (!env.JIRA_TOKEN) fail('A Jira token is required.');
console.log('Optional defaults, press Enter to skip:');
for (const [name, label] of OPTIONAL_VARS) {
  const value = process.env[name] ?? (await ask(`  ${label}: `));
  if (value) env[name] = value;
}

process.stdout.write('\nChecking the token against Jira... ');
try {
  const res = await fetch(`${JIRA_BASE_URL}/rest/api/2/myself`, {
    headers: { Authorization: `Bearer ${env.JIRA_TOKEN}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) console.log(`✓ logged in as ${(await res.json()).displayName}`);
  else console.log(`✗ Jira answered ${res.status}; check the token. Continuing anyway.`);
} catch {
  console.log('✗ Jira is unreachable (VPN?). Continuing anyway.');
}

console.log('\n3. Claude Code');
if (commandExists('claude')) {
  const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const display = (args) =>
    args.map((arg) => (arg.startsWith('JIRA_TOKEN=') ? 'JIRA_TOKEN=***' : /\s/.test(arg) ? `"${arg}"` : arg));
  // Replace an earlier registration, if there is one.
  const removeArgs = ['mcp', 'remove', SERVER_NAME, '--scope', 'user'];
  // Passed as one string: Node 24+ warns about separate args combined with shell: true.
  spawnSync(['claude', ...removeArgs].join(' '), { stdio: 'ignore', shell: true });
  const addArgs = ['mcp', 'add', SERVER_NAME, '--scope', 'user', ...envArgs, '--', 'node', serverPath];
  run('claude', addArgs, { display: display(addArgs) });
} else {
  console.log('  Claude Code (claude) is not installed; skipping.');
}

console.log('\n4. VS Code');
const vscode = (await ask('Also add it to VS Code (GitHub Copilot)? [y/N] ')).toLowerCase();
if (vscode === 'y' || vscode === 'yes') addToVscode(env);
else console.log('  skipped');

rl.close();
console.log(`\nDone. In Claude Code, run /mcp to see "${SERVER_NAME}".`);
