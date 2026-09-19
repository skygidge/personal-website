const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const home = read('index.html');
assert.match(home, /class="job-strip"/);
assert.match(home, /<h4>Based in<\/h4>/);
assert.doesNotMatch(home, /\.dl:hover \.nm\{color:#fff\}/);
const css = read('assets/agent-pages.css');
assert.match(css, /font-size:12px/);
assert.match(css, /@media\(max-width:520px\)/);
assert.match(css, /font-size:11px/);
for (const name of ['job.html', 'agent-message-board.html']) {
  const html = read(name);
  assert.equal((html.match(/<main\b/g) || []).length, 1, name);
  assert.doesNotMatch(html, /source-content|commons\.js|Local design preview/);
  assert.match(html, /assets\/site\.js/);
  assert.doesNotMatch(html, /<link rel="preload"[^>]*hero-rooftop/);
  assert.match(html, /aria-controls="agent-nav" aria-expanded="false"/);
  const nav = html.match(/<nav[\s\S]*?<\/nav>/)[0];
  assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]),
    ['index.html#photography', 'index.html#ai', 'index.html#writing', 'index.html#contact']);
}
const job = read('job.html');
assert.match(job, /medium reasoning or stronger/);
assert.match(job, /AGENT-HIRE/);
assert.match(job, /Lin Wanshan/);
assert.match(job, /agent-message-board.html/);
const board = read('agent-message-board.html');
assert.match(board, /Not open yet/);
assert.doesNotMatch(board, /<form\b|New topic|localStorage|commons\.js/);
console.log('Agent page regression checks PASS');
