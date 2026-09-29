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

test('match-3 releases an interrupted pointer drag through every browser cancellation path', () => {
  const html = fs.readFileSync(path.join(root, 'games/match3.html'), 'utf8');
  assert.match(html, /\.grid \.gem\.dragging,[^{}]*\.grid \.gem\.drag-peer\{transform:translate/,
    'drag motion must outrank the desktop hover transform');
  assert.match(html, /function setSwapProgress[\s\S]*rules\.swapPath/);
  assert.match(html, /pointermove[\s\S]*setSwapProgress\(drag\.index, target, progress, vector\)/);
  assert.match(html, /function cancelActiveDrag\(event\)[\s\S]*pointerStart = null;[\s\S]*returnDrag\(/);
  assert.match(html, /grid\.addEventListener\('pointercancel', cancelActiveDrag\)/);
  assert.match(html, /grid\.addEventListener\('lostpointercapture', cancelActiveDrag\)/);
  assert.match(html, /window\.addEventListener\('blur', cancelActiveDrag\)/);
});
