import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';

let db,admin,directory;const sessions=[];
const owner=randomUUID(),other=randomUUID(),client='synthetic-claude-client';
async function session(user=owner,clientID=client){
 const c=db.getPgClient();await c.connect();sessions.push(c);await c.query('SET ROLE authenticated');
 await c.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,role:'authenticated',...(clientID===null?{}:{client_id:clientID})})]);return c;
}
async function call(c,tool,args={}){return (await c.query('SELECT public.streamline_mcp_call($1,$2) result',[tool,args])).rows[0].result;}
async function note(extra={}){const id=randomUUID();await admin.query('INSERT INTO notes(id,user_id,content,is_private,is_deleted,trashed_date) VALUES($1,$2,$3,$4,$5,$6)',[id,extra.owner??owner,extra.content??'original',extra.private??false,extra.deleted??false,extra.trashed??null]);return id;}
async function task(extra={}){const id=randomUUID();await admin.query('INSERT INTO tasks(id,user_id,name,note,series_id) VALUES($1,$2,$3,$4,$5)',[id,extra.owner??owner,'Synthetic task','original',extra.series??null]);return id;}
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'streamline-hosted-test-'));
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 db=new EmbeddedPostgres({databaseDir:join(directory,'db'),port,user:'postgres',password:randomUUID(),persistent:true,createPostgresUser:false,postgresFlags:['-h','127.0.0.1','-k',''],onLog:()=>{},onError:console.error});
 await db.initialise();await db.start();admin=db.getPgClient();await admin.connect();
 await admin.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;CREATE ROLE authenticator;
 CREATE SCHEMA auth;CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claims',true)::jsonb $$;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
 GRANT USAGE ON SCHEMA auth TO authenticated,anon,service_role;
 CREATE PUBLICATION supabase_realtime;`);
 for(const name of ['schema.sql','note_external_read_state_migration.sql','task_guarded_null_expected_migration.sql'])await admin.query(await readFile(new URL(`./fixtures/native-${name}`,import.meta.url),'utf8'));
 await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
 CREATE FUNCTION public.native_definer_probe() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $f$
BEGIN
RETURN 42;
END;$f$;
 CREATE SCHEMA storage;CREATE TABLE storage.objects(id uuid);ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA storage TO authenticated;GRANT SELECT ON storage.objects TO authenticated;
 CREATE POLICY native_access ON storage.objects FOR ALL TO authenticated USING(true);`);
 await admin.query(await readFile(new URL('../migrations/202611220001_hosted_mcp.sql',import.meta.url),'utf8'));
 await admin.query('INSERT INTO auth.users VALUES($1),($2)',[owner,other]);
 await admin.query('INSERT INTO streamline_mcp_private.settings(owner_id,client_id,enabled,writes_enabled) VALUES($1,$2,true,true)',[owner,client]);
});
beforeEach(async()=>{await admin.query('TRUNCATE streamline_mcp_private.rate_limits');});
after(async()=>{await Promise.all(sessions.map(c=>c.end()));if(admin)await admin.end();if(db)await db.stop();if(directory)await rm(directory,{recursive:true,force:true});});
test('OAuth cannot read tables, storage, write directly, call native definers or access ledger; native sessions retain access',async()=>{
 const id=await note({private:true}),c=await session(),native=await session(owner,null);
 assert.deepEqual((await c.query('SELECT * FROM notes')).rows,[]);
 assert.equal((await c.query('UPDATE notes SET content=$1 WHERE id=$2',['bad',id])).rowCount,0);
 await assert.rejects(c.query('INSERT INTO notes(id,user_id) VALUES($1,$2)',[randomUUID(),owner]),/row-level security/);
 assert.deepEqual((await c.query('SELECT * FROM storage.objects')).rows,[]);
 await assert.rejects(c.query('SELECT public.native_definer_probe()'),/OAuth connector/);
 await assert.rejects(c.query('SELECT public.upsert_task_if_current($1)',[randomUUID()]),/OAuth connector/);
 await assert.rejects(c.query('SELECT * FROM streamline_mcp_private.requests'),/permission denied/);
 assert.equal((await native.query('SELECT public.native_definer_probe() value')).rows[0].value,42);
 assert.equal((await native.query('SELECT id FROM notes WHERE id=$1',[id])).rowCount,1);
});
test('wrong user/client, native and revoked identities denied',async()=>{
 for(const c of [await session(other),await session(owner,'other-client'),await session(owner,null)])await assert.rejects(call(c,'list_tags'),/access denied/);
 const c=await session();await admin.query('UPDATE streamline_mcp_private.settings SET enabled=false');
 try{await assert.rejects(call(c,'list_tags'),/access denied/);}finally{await admin.query('UPDATE streamline_mcp_private.settings SET enabled=true');}
});
test('REST pre-request guard blocks OAuth access to arbitrary current/future routes and allows native traffic',async()=>{
 const c=await session();
 for(const path of ['/notes','/rpc/upsert_task_if_current','/rpc/future_function','/future_table']){
  await c.query("SELECT set_config('request.path',$1,false)",[path]);await assert.rejects(c.query('SELECT public.streamline_mcp_pre_request()'),/scoped API/);
 }
 await c.query("SELECT set_config('request.path','/rpc/streamline_mcp_call',false)");await c.query('SELECT public.streamline_mcp_pre_request()');
 const native=await session(owner,null);await native.query("SELECT set_config('request.path','/notes',false)");await native.query('SELECT public.streamline_mcp_pre_request()');
});
test('private, foreign, trashed and deleted notes never appear by search or direct ID',async()=>{
 const c=await session();const ids=[await note({private:true}),await note({owner:other}),await note({deleted:true}),await note({trashed:new Date()})];
 const visible=await note();const result=await call(c,'search_notes');assert.ok(Array.isArray(result),JSON.stringify(result));
 assert.ok(result.some(n=>n.uuid===visible));for(const id of ids){assert.ok(!result.some(n=>n.uuid===id));assert.deepEqual(await call(c,'read_note',{uuid:id}),[]);assert.ok((await call(c,'append_note',{uuid:id,request_id:randomUUID(),content:'bad'})).error);}
});
test('read-only database gate defeats direct write RPC calls',async()=>{
 const c=await session();await admin.query('UPDATE streamline_mcp_private.settings SET writes_enabled=false');
 try{const r=await call(c,'create_note',{uuid:randomUUID(),request_id:randomUUID(),content:'x'});assert.match(r.error,/disabled/);assert.equal((await call(c,'__authorize')).writes_enabled,false);}
 finally{await admin.query('UPDATE streamline_mcp_private.settings SET writes_enabled=true');}
});
test('create, edit, append and metadata-only note writes preserve native revision and external-unread semantics',async()=>{
 const c=await session(),id=randomUUID();let r=await call(c,'create_note',{uuid:id,request_id:randomUUID(),content:'# Title\nBody'});assert.equal(r.success,true,JSON.stringify(r));
 let old=(await admin.query('SELECT * FROM notes WHERE id=$1',[id])).rows[0];assert.equal(old.external_update_revision,'1');
 r=await call(c,'update_note',{uuid:id,request_id:randomUUID(),expected_revision:Number(old.revision),content:'Changed'});assert.equal(r.success,true,JSON.stringify(r));
 let row=(await admin.query('SELECT * FROM notes WHERE id=$1',[id])).rows[0];assert.ok(row.last_edited_at>=old.last_edited_at);assert.equal(row.external_update_revision,'2');
 const stamp=row.last_edited_at.getTime();r=await call(c,'update_note',{uuid:id,request_id:randomUUID(),expected_revision:Number(row.revision),is_flagged:true});assert.equal(r.success,true,JSON.stringify(r));
 row=(await admin.query('SELECT * FROM notes WHERE id=$1',[id])).rows[0];assert.equal(row.last_edited_at.getTime(),stamp);assert.equal(row.external_update_revision,'2');
 const stale=await call(c,'update_note',{uuid:id,request_id:randomUUID(),expected_revision:1,content:'overwrite'});assert.match(stale.error,/Conflict/);
});
test('concurrent duplicate retries commit once, different appends all survive, changed key payload fails',async()=>{
 const id=await note(),cs=await Promise.all(Array.from({length:8},()=>session()));const args={uuid:id,request_id:randomUUID(),content:'contribution'};
 const r=await Promise.all(cs.map(c=>call(c,'append_note',args)));assert.ok(r.every(x=>x.success),JSON.stringify(r));assert.deepEqual(r[0],r[7]);
 assert.equal((await admin.query('SELECT content FROM notes WHERE id=$1',[id])).rows[0].content,'original\n\ncontribution');
 await Promise.all(cs.map((c,i)=>call(c,'append_note',{uuid:id,request_id:randomUUID(),content:`addition-${i}`})));
 assert.equal((await admin.query('SELECT content FROM notes WHERE id=$1',[id])).rows[0].content.split('\n\n').length,10);
 assert.ok((await call(cs[0],'append_note',{...args,content:'changed'})).error);
});
test('task revisions reject stale writes and advance beyond older transactions; recurring writes rejected',async()=>{
 const c=await session(),id=await task();const old=(await call(c,'read_task',{uuid:id}))[0];assert.ok(old);
 let r=await call(c,'append_task_note',{uuid:id,request_id:randomUUID(),content:'added'});assert.equal(r.success,true,JSON.stringify(r));
 r=await call(c,'update_task',{uuid:id,request_id:randomUUID(),expected_updated_at:old.updated_at,notes:'stale'});assert.match(r.error,/Conflict/);
 const native=await session(owner,null);await native.query('BEGIN');const before=(await admin.query('SELECT updated_at FROM tasks WHERE id=$1',[id])).rows[0].updated_at;
 await call(c,'append_task_note',{uuid:id,request_id:randomUUID(),content:'second'});await native.query('UPDATE tasks SET name=name WHERE id=$1',[id]);await native.query('COMMIT');
 assert.ok((await admin.query('SELECT updated_at FROM tasks WHERE id=$1',[id])).rows[0].updated_at>before);
 const recurring=await task({series:randomUUID()});assert.ok((await call(c,'append_task_note',{uuid:recurring,request_id:randomUUID(),content:'bad'})).error);
 const fresh=(await call(c,'read_task',{uuid:id}))[0];r=await call(c,'complete_task',{uuid:id,request_id:randomUUID(),expected_updated_at:fresh.updated_at});assert.equal(r.success,true,JSON.stringify(r));
});
test('bounds, unexpected args, foreign tags, unavailable tools and malformed IDs fail closed without contents in errors',async()=>{
 const c=await session();for(const [tool,args] of [['delete_note',{uuid:randomUUID()}],['search_notes',{limit:50000}],['search_notes',{offset:-1}],['read_note',{uuid:'not-uuid'}],['create_note',{uuid:randomUUID(),request_id:randomUUID(),content:'secret-text',tag_ids:[randomUUID()]}],['create_note',{uuid:randomUUID(),request_id:randomUUID(),content:'secret-text',is_private:false}]]){
  const result=await call(c,tool,args);assert.ok(result.error,JSON.stringify(result));assert.ok(!JSON.stringify(result).includes('secret-text'));
 }
});
test('rate limit is durable across sessions and audit contains no note bodies',async()=>{
 const c=await session();for(let i=0;i<120;i++)assert.equal((await call(c,'__authorize')).authorized,true);
 assert.match((await call(await session(),'list_tags')).error,/Rate limit/);
 const cols=(await admin.query("SELECT column_name FROM information_schema.columns WHERE table_schema='streamline_mcp_private' AND table_name='audit'")).rows.map(x=>x.column_name);assert.deepEqual(cols,['id','happened_at','tool','succeeded']);
});
