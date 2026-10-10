import test from 'node:test';
import assert from 'node:assert/strict';
import {ToolExecutor} from '../dist/index.js';

const uuid = '11111111-1111-1111-1111-111111111111';
const user = '33333333-3333-3333-3333-333333333333';
function fixture(content = '') {
  const writes = [];
  const executor = new ToolExecutor({
    getUserID: () => user,
    select: async () => [{id: uuid, content, last_edited_at: '2026-01-01T00:00:00Z'}],
    update: async (table, filters, body) => { writes.push({table, body}); return []; },
    insert: async (table, body) => { writes.push({table, body}); return body; },
  });
  return {executor, writes};
}

test('replacing an empty note advances the timestamp used by app content sync', async () => {
  const {executor, writes} = fixture();
  assert.equal(JSON.parse(await executor.execute('update_note', {uuid, content: 'Agent text'})).success, true);
  const {body} = writes[0];
  assert.equal(body.content, 'Agent text');
  assert.equal(body.last_edited_at, body.updated_at);
  assert.ok(Date.parse(body.last_edited_at) > Date.parse('2026-01-01T00:00:00Z'));
});

test('append updates content timestamp and previews, including for an empty note', async () => {
  for (const existing of ['', 'Title']) {
    const {executor, writes} = fixture(existing);
    await executor.execute('update_note', {uuid, append: 'Added paragraph'});
    const {body} = writes[0];
    assert.equal(body.content, existing + '\n\nAdded paragraph');
    assert.equal(body.last_edited_at, body.updated_at);
    assert.equal(body.first_line_clean, existing || 'Added paragraph');
    assert.equal(body.second_line_clean, existing ? 'Added paragraph' : '');
    assert.equal(body.word_count, existing ? 3 : 2);
    assert.equal(body.character_count, [...body.content].length);
  }
});

test('clearing content advances the edit timestamp', async () => {
  const {executor, writes} = fixture('Old text');
  await executor.execute('update_note', {uuid, content: ''});
  assert.equal(writes[0].body.content, '');
  assert.equal(writes[0].body.last_edited_at, writes[0].body.updated_at);
  assert.equal(writes[0].body.word_count, 0);
});

test('metadata-only and identical-content updates preserve the edit timestamp', async () => {
  for (const args of [{is_flagged: true}, {is_archived: true}, {content: 'Same text'}]) {
    const {executor, writes} = fixture('Same text');
    await executor.execute('update_note', {uuid, ...args});
    assert.equal(Object.hasOwn(writes[0].body, 'last_edited_at'), false);
    assert.ok(writes[0].body.updated_at);
  }
});

test('creating a note supplies a content timestamp explicitly', async () => {
  const {executor, writes} = fixture();
  await executor.execute('create_note', {content: 'Created note'});
  const {body} = writes[0];
  assert.equal(body.last_edited_at, body.created_at);
  assert.equal(body.last_edited_at, body.updated_at);
  assert.equal(body.character_count, 12);
});

const markdown = '\n---\n# **Lesson**\n## [Subtitle](https://example.com)\n- [x] `Done`\n> ==More==';
for (const operation of ['create_note', 'update_note']) {
  test(`${operation} stores readable markdown previews`, async () => {
    const {executor, writes} = fixture();
    await executor.execute(operation, {uuid, content: markdown});
    assert.equal(writes[0].body.first_line_clean, 'Lesson');
    assert.equal(writes[0].body.second_line_clean, 'Subtitle Done More');
  });
}
test('append rebuilds markdown previews from the complete body', async () => {
  const {executor, writes} = fixture('# **Lesson**');
  await executor.execute('update_note', {uuid, append: '## _Subtitle_'});
  assert.equal(writes[0].body.first_line_clean, 'Lesson');
  assert.equal(writes[0].body.second_line_clean, 'Subtitle');
});
