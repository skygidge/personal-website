const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const home = read('index.html');

assert.match(home, /class="job-strip"/);
assert.match(home, /<h4>Based in<\/h4>/);
assert.doesNotMatch(home, /\.dl:hover \.nm\{color:#fff\}/);
assert.match(home, /@media \(min-width:680px\) and \(max-width:900px\)\s*\{\s*\.aigrid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
assert.match(home, /\.aic\.span2,\.epub-feature\{grid-column:span 2\}/);

const css = read('assets/agent-pages.css');
assert.match(css, /\.job-strip \.wrap\{[^}]*font-size:16px/);
assert.match(css, /@media\(max-width:520px\)/);
assert.match(css, /@media\(max-width:520px\)\{\.job-strip \.wrap\{font-size:13px/);
assert.match(css, /\.apply-copy p\{font-size:15px;line-height:1\.6;color:var\(--soft\);margin-top:17px\}/);
assert.match(css, /\.board-row\{/);
assert.match(css, /\.board-notice\{/);
assert.match(css, /\.board-load\{display:inline-flex/);

const expectedNav = ['index.html#photography', 'index.html#ai', 'index.html#writing', 'index.html#contact'];
for (const name of ['job.html', 'agent-message-board.html', 'agent-api.html']) {
  const html = read(name);
  assert.equal((html.match(/<main\b/g) || []).length, 1, name);
  assert.doesNotMatch(html, /source-content|commons\.js|Local design preview/);
  assert.match(html, /assets\/site\.js/);
  assert.doesNotMatch(html, /<link rel="preload"[^>]*hero-rooftop/);
  assert.match(html, /aria-controls="agent-nav" aria-expanded="false"/);
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]), expectedNav);
}

const job = read('job.html');
assert.match(job, /medium reasoning or stronger/);
assert.match(job, /AGENT-HIRE/);
assert.match(job, /Lin Wanshan/);
assert.match(job, /agent-message-board\.html/);
assert.match(job, /not an application/i);

const board = read('agent-message-board.html');
assert.match(board, /data-agent-board-api=""/);
assert.match(board, /assets\/agent-board\.js/);
assert.match(board, /id="board-notice"/);
assert.match(board, /id="board-rows"/);
assert.match(board, /id="load-more"/);
assert.match(board, /untrusted/i);
assert.match(board, /id="board-paused"/);
assert.match(board, /id="board-unavailable"/);
assert.doesNotMatch(board, /<form\b|<input\b|<textarea\b|New topic|localStorage|commons\.js/);

const guide = read('agent-api.html');
for (const route of ['POST \/api\/register', 'POST \/api\/messages', 'GET \/api\/messages', 'GET \/openapi\.json']) assert.match(guide, new RegExp(route));
assert.match(guide, /browsing permission alone/i);
assert.match(guide, /agent-message-board\.html/);
assert.doesNotMatch(guide, /<form\b|<input\b|<textarea\b|localStorage/);

const runtime = read('assets/agent-board.js');
assert.match(runtime, /\.textContent\s*=/);
assert.match(runtime, /next_cursor/);
assert.match(runtime, /parent_unavailable/);
assert.match(runtime, /writes\s*===\s*["']paused["']/);
assert.match(runtime, /renderUnavailable/);
assert.doesNotMatch(runtime, /innerHTML/);
assert.doesNotMatch(runtime, /method\s*:\s*["']POST["']/);

const { renderMessage } = require(path.join(root, 'assets', 'agent-board.js'));
class Element {
  constructor(tagName) { this.tagName = tagName.toUpperCase(); this.children = []; this.attributes = {}; this._text = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text; }
}
const documentStub = { createElement: tag => new Element(tag) };
const hostile = '<img src=x onerror="globalThis.executed=true">';
const row = renderMessage(documentStub, {
  message_id: 'msg_test', topic: 'testing', message: hostile, display_name: 'Hostile Agent', received_at: '2026-09-20T12:00:00.000Z'
});
const message = row.children[0].children.find(child => child.attributes.class === 'board-message');
assert.equal(message.textContent, hostile);
assert.equal(row.children[0].children.some(child => child.tagName === 'IMG'), false);
assert.match(row.children[1].textContent, /Hostile Agent/);
assert.equal(globalThis.executed, undefined);

console.log('Agent page regression checks PASS');
