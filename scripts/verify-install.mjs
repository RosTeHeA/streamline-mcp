// Exercise clone/install/update with an isolated Git remote, empty npm cache,
// and synthetic configuration. No live database is accessed.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const folder = await mkdtemp(join(tmpdir(), 'streamline-git-install-'));
const env = {...process.env, npm_config_cache: join(folder, 'npm-cache')};
const run = (command, args, cwd) => execFileSync(command, args, {cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
const commit = cwd => run('git', ['-c', 'user.name=Install Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-am', 'Synthetic install fixture'], cwd);

async function verifyInstalled(installation, expectedVersion) {
  const config = join(folder, 'synthetic-config.json');
  await writeFile(config, JSON.stringify({
    projectURL: 'http://127.0.0.1:1', apiKey: 'synthetic-test-only',
    userID: '33333333-3333-3333-3333-333333333333',
  }));
  const client = new Client({name: 'install-smoke-test', version: '1.0.0'}, {capabilities: {}});
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(installation, 'dist/index.js')], cwd: installation,
    env: {PATH: process.env.PATH, SUPABASE_CONFIG_PATH: config}, stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, expectedVersion);
    const {tools} = await client.listTools();
    for (const name of ['read_note', 'create_note', 'update_note', 'append_task_note']) {
      assert.ok(tools.some(tool => tool.name === name), `Missing ${name}`);
    }
  } finally { await client.close(); }
}

try {
  const remote = join(folder, 'remote');
  await mkdir(remote);
  const paths = run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], repo).split('\0').filter(Boolean);
  for (const path of paths) {
    assert.ok(!path.startsWith('dist/') && !path.startsWith('node_modules/'));
    let data;
    try { data = await readFile(join(repo, path)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await mkdir(dirname(join(remote, path)), {recursive: true});
    await writeFile(join(remote, path), data);
  }
  run('git', ['init', '--quiet', '-b', 'main'], remote);
  run('git', ['add', '.'], remote);
  commit(remote);
  const installation = join(folder, 'installation');
  run('git', ['clone', '--quiet', remote, installation], folder);
  run('npm', ['ci', '--no-audit', '--no-fund'], installation);
  await verifyInstalled(installation, manifest.version);
  console.log('PASS: clean clone + npm ci builds and initializes the MCP server');

  // Advance the fixture remote, then exercise the exact user-facing updater.
  const nextVersion = '0.0.0-install-test';
  await writeFile(join(remote, 'package.json'), JSON.stringify({...manifest, version: nextVersion}, null, 2) + '\n');
  const lock = JSON.parse(await readFile(join(remote, 'package-lock.json'), 'utf8'));
  lock.version = nextVersion;
  lock.packages[''].version = nextVersion;
  await writeFile(join(remote, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
  const source = join(remote, 'src/index.ts');
  const original = await readFile(source, 'utf8');
  const updated = original.replace('version: serverVersion }', 'version: serverVersion + "-rebuilt" }');
  assert.notEqual(updated, original);
  await writeFile(source, updated);
  commit(remote);
  run('npm', ['run', 'update'], installation);
  assert.equal(run('git', ['rev-parse', 'HEAD'], installation), run('git', ['rev-parse', 'HEAD'], remote));
  await verifyInstalled(installation, nextVersion + '-rebuilt');
  assert.equal(run('git', ['status', '--porcelain'], installation), '');
  console.log('PASS: npm run update pulls the new commit, rebuilds, and runs it from the same path');
} finally { await rm(folder, {recursive: true, force: true}); }
