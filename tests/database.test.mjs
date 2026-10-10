import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

// Always a disposable local PostgreSQL cluster. Never reads a config/DB URL.
let db, admin, directory;
const clients = [];
const user = randomUUID(), other = randomUUID();
async function session(role = 'service_role') {
  const client = db.getPgClient(); await client.connect(); clients.push(client);
  await client.query(`SET ROLE ${role}`);
  return client;
}
async function fixture(note = 'original', owner = user, extra = {}) {
  const id = randomUUID();
  await admin.query('INSERT INTO tasks(id,user_id,note,is_deleted,trashed_date) VALUES($1,$2,$3,$4,$5)', [id,owner,note,extra.deleted ?? false,extra.trashed ?? null]);
  return id;
}
async function append(c,id,content,key=randomUUID(),owner=user) {
  return (await c.query('SELECT public.append_task_note($1,$2,$3,$4) AS result',[owner,id,key,content])).rows[0].result;
}
async function task(id) {return (await admin.query('SELECT * FROM tasks WHERE id=$1',[id])).rows[0];}
async function waitForLock(pid) {
  const until = Date.now()+5000;
  while (Date.now()<until) {
    const r = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid]);
    if(r.rows[0]?.wait_event_type==='Lock') return;
    await new Promise(r=>setTimeout(r,10));
  }
  throw Error('second session did not wait for the task lock');
}
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'streamline-append-test-'));
  const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port;await new Promise(r=>listener.close(r));
  db=new EmbeddedPostgres({databaseDir:join(directory,'db'),port,user:'postgres',password:randomUUID(),persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1','-k',''],onLog:()=>{},onError:console.error});
  await db.initialise();await db.start();admin=db.getPgClient();await admin.connect();
  await admin.query(`CREATE ROLE service_role BYPASSRLS; CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.tasks(id uuid PRIMARY KEY,user_id uuid NOT NULL,note text,updated_at timestamptz DEFAULT now(),is_deleted boolean DEFAULT false,trashed_date timestamptz,last_mutation_id uuid,last_modified_device_id text);
    CREATE FUNCTION update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;
    CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated;
    GRANT SELECT,UPDATE ON public.tasks TO service_role;`);
  await admin.query(await readFile(new URL('../migrations/202610020001_append_task_note.sql',import.meta.url),'utf8'));
});
after(async()=>{await Promise.all(clients.map(c=>c.end()));if(admin)await admin.end();if(db)await db.stop();if(directory)await rm(directory,{recursive:true,force:true});});
test('preserves existing bytes, null/empty boundaries, revision and sync metadata',async()=>{
  const c=await session();
  for(const initial of [null,'','original\n',' \t']){
    const id=await fixture(initial);const before=await task(id);const key=randomUUID();
    const result=await append(c,id,'α😀\n',key);const after=await task(id);
    assert.equal(after.note,(initial??'')+(initial?'\n\n':'')+'α😀\n');
    assert.equal(result.appended,true);assert.equal(after.last_mutation_id,key);
    assert.equal(after.last_modified_device_id,'streamline-mcp');
    assert.ok(after.updated_at-before.updated_at>=2);
  }
});
test('simultaneous duplicate retries commit exactly once',async()=>{
  const id=await fixture();const key=randomUUID();const sessions=await Promise.all(Array.from({length:12},()=>session()));
  const results=await Promise.all(sessions.map(c=>append(c,id,'addition',key)));
  assert.equal(results.filter(r=>r.appended).length,1);assert.equal(new Set(results.map(r=>r.appended_at)).size,1);
  assert.equal((await task(id)).note,'original\n\naddition');
});
test('distinct concurrent appends retain every contribution',async()=>{
  const id=await fixture();const sessions=await Promise.all(Array.from({length:10},()=>session()));
  await Promise.all(sessions.map((c,i)=>append(c,id,`addition-${i}`)));
  assert.deepEqual(new Set((await task(id)).note.split('\n\n')),new Set(['original',...sessions.map((_,i)=>`addition-${i}`)]));
});
test('append waits for concurrent edit, then uses its committed text',async()=>{
  const id=await fixture();const editor=await session();const appender=await session();
  const pid=(await appender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await editor.query('BEGIN');await editor.query('UPDATE tasks SET note=$1 WHERE id=$2',['new user edit',id]);
  const pending=append(appender,id,'addition');
  await waitForLock(pid);await editor.query('COMMIT');await pending;
  assert.equal((await task(id)).note,'new user edit\n\naddition');
});
test('idempotency survives intervening intentional replacement and rejects changed payload',async()=>{
  const id=await fixture();const c=await session();const key=randomUUID();await append(c,id,'A',key);
  await admin.query('UPDATE tasks SET note=$1 WHERE id=$2',['intentional rewrite',id]);const before=await task(id);
  assert.equal((await append(c,id,'A',key)).appended,false);assert.deepEqual(await task(id),before);
  await assert.rejects(append(c,id,'B',key),/different content/);assert.deepEqual(await task(id),before);
});
test('keys scoped by owner/task; unauthorized, missing, trashed tasks rejected',async()=>{
  const a=await fixture(),b=await fixture('',other);const c=await session(),key=randomUUID();
  await append(c,a,'A',key);await append(c,b,'B',key,other);
  await assert.rejects(append(c,a,'bad',randomUUID(),other),/unavailable/);
  for(const id of [randomUUID(),await fixture('x',user,{deleted:true}),await fixture('x',user,{trashed:new Date()})])await assert.rejects(append(c,id,'bad'),/unavailable/);
  assert.equal((await task(a)).note,'original\n\nA');assert.equal((await task(b)).note,'B');
});
test('SQL rejects blank/null/oversize input and accepts 65536 UTF-8 bytes',async()=>{
  const id=await fixture(),c=await session();
  for(const text of [null,'',' \t\n','a'.repeat(65537),'😀'.repeat(16385)])await assert.rejects(append(c,id,text),/Invalid append/);
  await assert.rejects(append(c,id,'x',null),/Invalid append/);
  await append(c,id,'😀'.repeat(16384));
});
test('ledger failure rolls back the note update',async()=>{
  const id=await fixture(),c=await session();const before=await task(id);
  await admin.query(`CREATE FUNCTION public.fail_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test ledger failure'; END $$;
    CREATE TRIGGER fail_ledger BEFORE INSERT ON public.task_note_append_requests FOR EACH ROW EXECUTE FUNCTION public.fail_ledger();`);
  try{await assert.rejects(append(c,id,'must roll back'),/test ledger failure/);assert.deepEqual(await task(id),before);}
  finally{await admin.query('DROP TRIGGER fail_ledger ON public.task_note_append_requests; DROP FUNCTION public.fail_ledger()');}
});
test('unprivileged callers cannot invoke RPC or access ledger',async()=>{
  const id=await fixture();
  for(const role of ['anon','authenticated']){
    const c=await session(role);await assert.rejects(append(c,id,'denied'),/permission denied/);
    await assert.rejects(c.query('SELECT * FROM task_note_append_requests'),/permission denied/);
  }
  await assert.rejects(append(admin,id,'denied'),/Service role required/);
});

test('append rechecks ownership/deletion after waiting for concurrent changes',async()=>{
  for(const change of ["user_id", "is_deleted"]){
    const id=await fixture(),editor=await session(),appender=await session();
    const pid=(await appender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await editor.query('BEGIN');
    if(change==='user_id')await editor.query('UPDATE tasks SET user_id=$1 WHERE id=$2',[other,id]);
    else await editor.query('UPDATE tasks SET is_deleted=true WHERE id=$1',[id]);
    const pending=assert.rejects(append(appender,id,'must not append'),/unavailable/);
    await waitForLock(pid);await editor.query('COMMIT');await pending;
    assert.equal((await task(id)).note,'original');
    assert.equal((await admin.query('SELECT count(*) FROM task_note_append_requests WHERE task_id=$1',[id])).rows[0].count,'0');
  }
});
test('unknown timestamp override fails closed and rolls back',async()=>{
  const id=await fixture(),c=await session();
  await admin.query('CREATE TRIGGER zzz_unknown_override BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()');
  try{
    await c.query('BEGIN');
    // Make the existing revision newer than the append transaction's NOW().
    await admin.query('UPDATE tasks SET note=note WHERE id=$1',[id]);
    await assert.rejects(append(c,id,'must roll back'),/revision trigger was overridden/);
    await c.query('ROLLBACK');assert.equal((await task(id)).note,'original');
  }finally{await admin.query('DROP TRIGGER zzz_unknown_override ON tasks');}
});
test('documents residual timestamp regression from later ordinary native updates',async()=>{
  const c=await session(),old=await session();await old.query('BEGIN');
  const baseline=(await old.query('SELECT now() AS t')).rows[0].t;
  const id=await fixture();await admin.query('ALTER TABLE tasks DISABLE TRIGGER update_tasks_updated_at');
  try{await admin.query('UPDATE tasks SET updated_at=$1 WHERE id=$2',[baseline,id]);}
  finally{await admin.query('ALTER TABLE tasks ENABLE TRIGGER update_tasks_updated_at');}
  await append(c,id,'addition');
  await old.query('UPDATE tasks SET note=note WHERE id=$1',[id]);await old.query('COMMIT');
  assert.equal((await task(id)).updated_at.getTime(),baseline.getTime());
  assert.equal((await task(id)).note,'original\n\naddition');
});
test('partway migration failure rolls back helper, trigger, and grants',async()=>{
  await db.createDatabase('migration_failure');const c=db.getPgClient('migration_failure');await c.connect();
  try{
    await c.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,user_id uuid,note text,updated_at timestamptz,is_deleted boolean,trashed_date timestamptz,last_mutation_id uuid,last_modified_device_id text);
      CREATE TABLE task_note_append_requests(sentinel text); INSERT INTO task_note_append_requests VALUES('leave me intact');`);
    await assert.rejects(c.query(await readFile(new URL('../migrations/202610020001_append_task_note.sql',import.meta.url),'utf8')),/already exists/);
    await c.query('ROLLBACK');
    assert.equal((await c.query("SELECT to_regprocedure('public.streamline_append_note_revision()') AS helper")).rows[0].helper,null);
    assert.equal((await c.query("SELECT count(*) FROM pg_trigger WHERE tgname='zz_streamline_append_note_revision'")).rows[0].count,'0');
    assert.equal((await c.query('SELECT sentinel FROM task_note_append_requests')).rows[0].sentinel,'leave me intact');
  }finally{await c.end();await db.dropDatabase('migration_failure');}
});
