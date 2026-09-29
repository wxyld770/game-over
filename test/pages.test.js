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

test('doudizhu keeps turn, played cards, settlement hands, and next-round controls at their seats', () => {
  const html = fs.readFileSync(path.join(root, 'games/doudizhu.html'), 'utf8');
  assert.match(html, /id="activePlay"[^>]*hidden[\s\S]*id="activePlayLabel"[\s\S]*id="playedCards"/,
    'the current trick should have a seat-positioned container');
  assert.match(html, /activePlay\.className = `active-play\$\{activeSeat \? ` seat-\$\{activeSeat\}` : ''\}`/,
    'the current trick should follow the player seat');
  assert.match(html, /\.bottom \{ grid-column:1 \/ -1; grid-row:1;/,
    'the bottom cards should stay centered at the top of the tabletop');
  assert.match(html, /\.active-play\.seat-left \{ transform:translateX\(-38%\); \}[\s\S]*\.active-play\.seat-right \{ transform:translateX\(38%\); \}/,
    'opponent plays should sit near the table center while remaining side-specific');
  assert.match(html, /item\.dataset\.playerId = player\.id/,
    'seat elements should retain the player identity for table interactions');
  assert.match(html, /timer\.dataset\.selfTurn === 'true' \? `请\$\{action\} · \$\{seconds\} 秒`/,
    'the local countdown should name the required action beside the local seat');
  assert.match(html, /id="handLive"[\s\S]*id="roundReady"[^>]*hidden[\s\S]*id="again"/,
    'the hand area should own the next-round ready state');
  assert.match(html, /\$\('handLive'\)\.hidden = complete;[\s\S]*\$\('roundReady'\)\.hidden = !complete/,
    'settlement should replace the live hand instead of leaving stale cards visible');
  assert.match(html, /state\.phase === 'finished' && player\.id !== state\.selfId[\s\S]*reveal\.className = 'seat-reveal'[\s\S]*Array\.isArray\(player\.hand\)/,
    'settlement should reveal each opponent hand below that player seat');
  assert.match(html, /id="interactionLayer"[^>]*aria-live="polite"/,
    'table interactions need an independent live animation layer');
  assert.match(html, /const canInteract = player\.id !== state\.selfId && !player\.left;[\s\S]*document\.createElement\(canInteract \? 'button' : 'span'\)/,
    'only another player avatar should become an interaction button');
  assert.match(html, /avatar\.setAttribute\('aria-label', `向\$\{player\.name\}扔番茄`\);[\s\S]*avatar\.title = `向\$\{player\.name\}扔番茄`/,
    'avatar interactions should be named for keyboard and pointer users');
  assert.match(html, /avatar\.addEventListener\('click', \(\) => sendTomato\(player\.id\)\)[\s\S]*async function sendTomato\(targetId\)/,
    'tomato interactions should use an independent request path');
  assert.match(html, /async function sendTomato[\s\S]*action: 'interact',[\s\S]*interaction: 'tomato',[\s\S]*targetId/,
    'tomato interactions should use the authenticated room action endpoint');
  assert.match(html, /interaction\.id !== lastInteractionId[\s\S]*!seenInteractionIds\.has\(interaction\.id\)[\s\S]*requestAnimationFrame\(\(\) => showTomatoInteraction\(interaction\)\)/,
    'the same interaction must not replay through both POST and SSE state updates');
  assert.doesNotMatch(html, /Number\(interaction\.expiresAt\) > Date\.now\(\)/,
    'client clock skew should not discard server-approved interactions');
  const effectBlock = html.match(/const playEffectMeta = Object\.freeze\(\{([\s\S]*?)\n      \}\);/)?.[1] || '';
  for (const type of ['bomb', 'rocket', 'straight', 'pair-straight', 'plane', 'plane-single', 'plane-pair']) {
    assert.ok(effectBlock.includes(type), `${type} should have a play effect`);
  }
  assert.match(effectBlock, /rocket:[^\n]*sparks: 28[^\n]*impact: 'rocket-impact'/,
    'the rocket effect should be visibly stronger than the bomb effect');
  assert.doesNotMatch(effectBlock, /^\s*(?:single|pair|triple):/m,
    'ordinary card patterns should not trigger a large table effect');
  assert.doesNotMatch(html, /triple-pair|三带二/, 'three cards with a pair should not remain in client rules');
  assert.match(html, /三张可以带一张单牌，不支持三带一对[\s\S]*飞机可以带与连续三张组数相同的单牌或对子/,
    'the visible rules should match the supported triple and plane variants');
});
