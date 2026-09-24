const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', 'public');
const pages = [
  'hub.html',
  'games/doudizhu.html',
  'games/sudoku.html',
  'games/minesweeper.html',
  'games/spider.html',
  'games/jump.html',
  'games/match3.html',
];

test('all game pages have parseable inline JavaScript and a return path', () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /<html lang="zh-CN">/, page);
    assert.match(html, /<title>[^<]+<\/title>/, page);
    if (page !== 'hub.html') assert.match(html, /href="\/"/, `${page} should return to the hub`);
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length, `${page} should have playable JavaScript`);
    for (const [, source] of scripts) {
      new vm.Script(source, { filename: page });
    }
  }
});
