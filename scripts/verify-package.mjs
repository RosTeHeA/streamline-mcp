// Verify both supported distribution paths without using live credentials or data.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, copyFile, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const folder = await mkdtemp(join(tmpdir(), 'streamline-package-'));
const env = {...process.env, npm_config_cache: join(folder, 'npm-cache')};
const run = (command, args, cwd) => execFileSync(command, args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});

async function verifyInstalled(installation) {
  const config = join(installation, 'synthetic-config.json');
  await writeFile(config, JSON.stringify({
    projectURL: 'http://127.0.0.1:1', apiKey: 'synthetic-test-only',
    userID: '33333333-3333-3333-3333-333333333333',
  }));
  const client = new Client({name: 'package-smoke-test', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({
    command: join(installation, 'node_modules', '.bin', 'streamline-mcp'),
    cwd: installation,
    env: {PATH: process.env.PATH, SUPABASE_CONFIG_PATH: config},
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, manifest.version);
    const {tools} = await client.listTools();
    for (const name of ['read_note', 'create_note', 'update_note', 'append_task_note']) {
      assert.ok(tools.some(tool => tool.name === name), `Missing ${name}`);
    }
  } finally {
    await client.close();
  }
}

try {
  // Git installs must compile from source, with neither dist nor node_modules
  // carried over from the developer's checkout.
  const snapshot = join(folder, 'source');
  await mkdir(snapshot);
  const paths = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
  for (const path of paths) {
    assert.ok(!path.startsWith('dist/') && !path.startsWith('node_modules/'));
    await mkdir(dirname(join(snapshot, path)), {recursive: true});
    await copyFile(join(repo, path), join(snapshot, path));
  }
  run('git', ['init', '--quiet'], snapshot);
  run('git', ['add', '.'], snapshot);
  run('git', ['-c', 'user.name=Package Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'Synthetic release fixture'], snapshot);
  const revision = run('git', ['rev-parse', 'HEAD'], snapshot).trim();
  const gitInstall = join(folder, 'git-install');
  await mkdir(gitInstall);
  await writeFile(join(gitInstall, 'package.json'), '{"private":true}');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', `git+${pathToFileURL(snapshot).href}#${revision}`], gitInstall);
  await verifyInstalled(gitInstall);
  console.log('PASS: clean Git install builds automatically and completes MCP initialization');

  // Release downloads must contain compiled runtime files and exclude local
  // credentials, development dependencies, and machine-specific launch scripts.
  run('npm', ['run', 'build'], repo);
  const [pack] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', folder], repo));
  const files = new Set(pack.files.map(file => file.path));
  for (const path of ['package.json', 'dist/index.js', 'dist/append-task-note.js', 'docs/updating.md']) {
    assert.ok(files.has(path), `Missing packaged file: ${path}`);
  }
  for (const path of files) {
    assert.ok(path === 'package.json' || path === 'README.md' || path === 'CHANGELOG.md'
      || path.startsWith('dist/') || path.startsWith('docs/') || path.startsWith('migrations/'), `Unexpected packaged file: ${path}`);
  }
  const packedInstall = join(folder, 'packed-install');
  await mkdir(packedInstall);
  await writeFile(join(packedInstall, 'package.json'), '{"private":true}');
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', join(folder, pack.filename)], packedInstall);
  await verifyInstalled(packedInstall);
  console.log('PASS: release tarball contains the runtime and works with production dependencies only');
} finally {
  await rm(folder, {recursive: true, force: true});
}
