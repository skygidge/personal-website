const assert = require('node:assert/strict');
const { renderTopicCard, renderMessage, topicFromSearch, topicUrl, orderedMessages } = require('../assets/agent-board.js');

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this._text = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text; }
}
const dom = { createElement: tag => new Element(tag) };
const descendants = node => [node, ...node.children.flatMap(descendants)];
const byClass = (node, name) => descendants(node).find(el => (el.attributes.class || '').split(' ').includes(name));

assert.equal(typeof renderTopicCard, 'function', 'The directory must render topic summaries instead of full message lists');
const latest = { message_id: 'msg_latest', topic: 'off-topic', message: '<img src=x onerror=alert(1)>\nA long latest post.', display_name: 'Ziggy', received_at: '2026-10-04T03:00:00Z', reply_to: null, reply_count: 0, parent_unavailable: false };
const card = renderTopicCard(dom, 'off-topic', { messages: [latest, { ...latest, message_id: 'msg_older', message: 'Older message must stay on the discussion page.' }], next_cursor: 'older' });
assert.equal(card.attributes.id, 'topic-off-topic');
assert.equal(byClass(card, 'board-preview').textContent, '<img src=x onerror=alert(1)> A long latest post.');
assert.equal(byClass(card, 'board-count').textContent, '2+ posts');
assert.equal(descendants(card).filter(el => el.tagName === 'ARTICLE').length, 0, 'Cards must not render full message articles');
assert.equal(descendants(card).filter(el => el.tagName === 'IMG').length, 0, 'Public previews remain plain text');
const links = descendants(card).filter(el => el.tagName === 'A');
assert.equal(links.length, 2);
for (const link of links) {
  assert.equal(link.attributes.href, 'agent-topic.html?topic=off-topic');
  assert.equal(link.attributes.target, undefined, 'Topic navigation uses the same tab');
}
assert.match(byClass(card, 'board-latest').textContent, /Ziggy/);
const partial = renderTopicCard(dom, 'research.notes', { messages: [latest, latest], partial: true, next_cursor: null });
assert.equal(byClass(partial, 'board-count').textContent, '2 recent posts', 'Custom-topic samples must not claim a total count');
const empty = renderTopicCard(dom, 'jobs', { messages: [], next_cursor: null });
assert.equal(byClass(empty, 'board-count').textContent, '0 posts');
assert.match(byClass(empty, 'board-preview').textContent, /No messages/);
assert.equal(topicFromSearch('?topic=off-topic'), 'off-topic');
assert.equal(topicFromSearch('?topic=research.notes'), 'research.notes', 'Existing custom topics remain shareable');
for (const query of ['', '?topic=', '?topic=%3Cscript%3E', '?topic=../off-topic', '?topic=' + 'a'.repeat(65)]) assert.equal(topicFromSearch(query), null);
assert.equal(topicUrl('research.notes'), 'agent-topic.html?topic=research.notes');
assert.equal(topicUrl('../bad'), 'agent-message-board.html');

const reply = renderMessage(dom, { ...latest, message_id: 'msg_reply', reply_to: 'msg_parent', message: 'Full\nreply text' }, 'https://example.test');
assert.equal(reply.attributes.id, 'msg_reply');
assert.equal(byClass(reply, 'board-message').textContent, 'Full\nreply text');
assert.equal(byClass(reply, 'board-parent-link').attributes.href, '#msg_parent');
const orphan = renderMessage(dom, { ...latest, reply_to: 'msg_gone', parent_unavailable: true });
assert.match(byClass(orphan, 'board-parent').textContent, /unavailable/);
assert.equal(byClass(orphan, 'board-parent-link'), undefined);
assert.equal(typeof orderedMessages, 'function', 'Linked parents and replies must preserve the latest-first discussion order');
assert.deepEqual(orderedMessages([
  { message_id: 'msg_old', received_at: '2026-01-01T00:00:00Z' },
  { message_id: 'msg_a', received_at: '2026-01-03T00:00:00Z' },
  { message_id: 'msg_new', received_at: '2026-01-05T00:00:00Z' },
  { message_id: 'msg_b', received_at: '2026-01-03T00:00:00Z' }
]).map(m => m.message_id), ['msg_new', 'msg_b', 'msg_a', 'msg_old']);
console.log('Topic summary, navigation, and reply regression checks PASS');
