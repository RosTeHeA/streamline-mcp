import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('symlink CLI initializes and lists/calls append tool over MCP with synthetic credentials',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'streamline-mcp-test-'));
  const requests=[];
  const user='33333333-3333-3333-3333-333333333333';
  const http=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk;
    const body=JSON.parse(data);requests.push({url:req.url,body});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({success:true,uuid:body.p_task_id,request_id:body.p_request_id,appended:true,appended_at:'2026-10-02T00:00:00Z'}));
  });
  await new Promise(r=>http.listen(0,'127.0.0.1',r));
  const config=join(folder,'config.json');
  await writeFile(config,JSON.stringify({projectURL:`http://127.0.0.1:${http.address().port}`,apiKey:'synthetic-test-only',userID:user}));
  const bin=join(folder,'streamline-mcp');await symlink(fileURLToPath(new URL('../dist/index.js',import.meta.url)),bin);
  const client=new Client({name:'append-test',version:'1.0.0'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:[bin],cwd:folder,env:{PATH:process.env.PATH,SUPABASE_CONFIG_PATH:config},stderr:'pipe'});
  try{
    await client.connect(transport);
    const listed=await client.listTools();assert.ok(listed.tools.some(t=>t.name==='append_task_note'));
    const args={uuid:'11111111-1111-1111-1111-111111111111',request_id:'22222222-2222-2222-2222-222222222222',content:'new contribution'};
    const reply=await client.callTool({name:'append_task_note',arguments:args});
    assert.equal(JSON.parse(reply.content[0].text).appended,true);
    assert.deepEqual(requests,[{url:'/rest/v1/rpc/append_task_note',body:{p_user_id:user,p_task_id:args.uuid,p_request_id:args.request_id,p_content:args.content}}]);
    const bad=await client.callTool({name:'append_task_note',arguments:{...args,request_id:'invalid'}});
    assert.equal(bad.isError,true);assert.equal(requests.length,1);
  }finally{await client.close();await new Promise(r=>http.close(r));await rm(folder,{recursive:true,force:true});}
});
