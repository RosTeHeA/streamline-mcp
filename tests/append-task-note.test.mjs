import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendTaskNote, appendTaskNoteTool } from '../dist/append-task-note.js';
import { SupabaseClient, ToolExecutor, tools } from '../dist/index.js';
const uuid = '11111111-1111-1111-1111-111111111111';
const request_id = '22222222-2222-2222-2222-222222222222';
const user = '33333333-3333-3333-3333-333333333333';
const args = { uuid, request_id, content: 'Keep this exactly\n' };
const response = { success: true, uuid, request_id, appended: true, appended_at: '2026-10-02T00:00:00Z' };
test('schema requires stable request ID and exposes separate append/rewrite tools', () => {
  assert.deepEqual(appendTaskNoteTool.inputSchema.required, ['uuid', 'content', 'request_id']);
  assert.equal(appendTaskNoteTool.inputSchema.additionalProperties, false);
  assert.equal(tools.filter(t => t.name === 'append_task_note').length, 1);
  assert.match(tools.find(t => t.name === 'update_task').description, /replaces/);
});
test('dispatch uses one scoped RPC, preserves content and retry key', async () => {
  const calls = [];
  const client = {getUserID: () => user, rpc: async (...p) => { calls.push(p); return response; }};
  const executor = new ToolExecutor(client);
  assert.deepEqual(JSON.parse(await executor.execute('append_task_note', args)), response);
  await appendTaskNote(client, args);
  assert.deepEqual(calls, Array(2).fill(['append_task_note', {p_user_id: user, p_task_id: uuid, p_request_id: request_id, p_content: args.content}]));
});
test('runtime input validation blocks bad args before any RPC', async () => {
  const client = {getUserID: () => user, rpc: () => { throw Error('unexpected RPC'); }};
  for (const invalid of [{}, {...args,uuid:'bad'}, {...args,request_id:undefined}, ...[null,'',' \t\r\n','\0','\ud800','a'.repeat(65537),'😀'.repeat(16385)].map(content => ({...args,content})), {...args,user_id:user}]) {
    await assert.rejects(appendTaskNote(client, invalid), error => !error.message.includes('unexpected RPC'));
  }
});
test('UTF-8 byte boundary accepted and uncertain response never reported successful', async () => {
  const client = {getUserID: () => user, rpc: async () => response};
  await appendTaskNote(client, {...args,content:'😀'.repeat(16384)});
  await assert.rejects(appendTaskNote({...client,rpc:async () => ({})},args), /outcome uncertain/);
});
test('HTTP uses RPC only; database errors do not leak note text or fall back', async () => {
  const calls = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (...p) => {calls.push(p);return new Response('private note in server error', {status:404});};
  try {
    const client = new SupabaseClient({projectURL:'http://127.0.0.1:1',apiKey:'test-only',userID:user});
    await assert.rejects(appendTaskNote(client,args), error => /same request_id/.test(error.message) && !/private note/.test(error.message));
    assert.equal(calls.length,1);
    assert.equal(calls[0][0],'http://127.0.0.1:1/rest/v1/rpc/append_task_note');
    assert.deepEqual(JSON.parse(calls[0][1].body),{p_user_id:user,p_task_id:uuid,p_request_id:request_id,p_content:args.content});
  } finally {globalThis.fetch = saved;}
});
test('existing update_task still intentionally replaces note', async () => {
  let received;
  const executor = new ToolExecutor({getUserID:()=>user,update: async (...params) => {received=params;return [];}});
  const result = JSON.parse(await executor.execute('update_task',{uuid,notes:'replacement'}));
  assert.equal(result.success,true);
  assert.equal(received[0],'tasks');
  assert.equal(received[2].note,'replacement');
});
