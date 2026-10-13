// Worker 純函式的單元測試（執行方式：在 worker 資料夾輸入 npm test）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { cleanChat, filterProfanity, prepareChat } from '../src/chat.js';
import { verifyTicket } from '../src/ticket.js';
import { parseState } from '../src/state.js';
import { originAllowed } from '../src/origin.js';

const b64url = buf => Buffer.from(buf).toString('base64url');
function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return body + '.' + b64url(createHmac('sha256', secret).update(body).digest());
}
const NOW = 1_800_000_000;
const good = { v: 1, uid: 7, name: '阿嵐', lv: 12, lvmax: 17, job: 'warrior', iat: NOW, exp: NOW + 300 };

test('票券：正確簽章可以通過', async () => {
  const t = await verifyTicket(sign(good, 'k1'), 'k1', NOW);
  assert.deepEqual(t, { uid: 7, name: '阿嵐', lv: 12, lvmax: 17, job: 'warrior', exp: NOW + 300 });
});

test('票券：密鑰不同、過期、竄改、格式錯誤都不通過', async () => {
  assert.equal(await verifyTicket(sign(good, 'k1'), 'k2', NOW), null);
  assert.equal(await verifyTicket(sign(good, 'k1'), 'k1', NOW + 301), null);
  const [body, sig] = sign(good, 'k1').split('.');
  const forged = b64url(JSON.stringify({ ...good, uid: 1 }));
  assert.equal(await verifyTicket(forged + '.' + sig, 'k1', NOW), null);
  assert.equal(await verifyTicket(body, 'k1', NOW), null);
  assert.equal(await verifyTicket('a.b.c', 'k1', NOW), null);
  assert.equal(await verifyTicket(sign(good, 'k1'), '', NOW), null);
  assert.equal(await verifyTicket(sign({ ...good, v: 2 }, 'k1'), 'k1', NOW), null);
});

test('聊天：清理空白與隱藏字元', () => {
  assert.equal(cleanChat('  你好​‮  世界\n'), '你好 世界');
  assert.equal(cleanChat('　'), '');
});

test('聊天：不雅字詞換成＊，全形英文也抓得到，其他字不動', () => {
  assert.equal(filterProfanity('你是白癡嗎？'), '你是＊＊嗎？');
  assert.equal(filterProfanity('ｓｈｉｔ'), '＊＊＊＊');
  assert.equal(filterProfanity('SHIT happens'), '＊＊＊＊ happens');
  assert.equal(filterProfanity('操作說明 三小時'), '操作說明 三小時');
  assert.equal(filterProfanity('😀fuck😀'), '😀＊＊＊＊😀');
});

test('聊天：長度與空白檢查', () => {
  assert.ok(prepareChat('').error);
  assert.ok(prepareChat('   ').error);
  assert.ok(prepareChat('字'.repeat(61)).error);
  assert.equal(prepareChat('字'.repeat(60)).text, '字'.repeat(60));
  assert.ok(prepareChat(123).error);
});

test('狀態：夾到合法範圍、等級上限、職業等級檢查', () => {
  const s = parseState({ x: 11230, y: -10, f: -1, st: 'walk', ak: 'skill', ad: 9, an: 3, job: 'knight', lv: 50, eq: { weapon: ['isword', 2], hat: ['BAD', 1] }, em: 2, en: 4 }, 20);
  assert.equal(s.x, 11200); assert.equal(s.y, 0); assert.equal(s.f, -1); assert.equal(s.ad, 1.5);
  assert.equal(s.lv, 20); assert.equal(s.job, 'novice');   // 等級被夾到 20，騎士需要 Lv.30
  assert.deepEqual(s.eq, { weapon: ['isword', 2] });
  assert.equal(s.em, 2);
  assert.equal(parseState({ x: 99999, y: 0, lv: 1 }, 10), null);
  assert.equal(parseState({ x: 1, y: 0, lv: 0 }, 10), null);
  assert.equal(parseState({ x: 1, y: 0, lv: 5, job: 'toString' }, 10).job, 'novice');
});

test('來源網站檢查', () => {
  assert.ok(originAllowed('https://peoplepop.github.io', {}));
  assert.ok(originAllowed('http://127.0.0.1:8770', {}));
  assert.ok(originAllowed('http://localhost', {}));
  assert.ok(originAllowed('https://claude.ai', {}));
  assert.ok(originAllowed('https://abc.claudeusercontent.com', {}));
  assert.ok(originAllowed('https://x.example', { EXTRA_ORIGINS: 'https://x.example/, https://y.example' }));
  assert.ok(!originAllowed('https://evil.example', {}));
  assert.ok(!originAllowed('https://peoplepop.github.io.evil.example', {}));
  assert.ok(!originAllowed('https://evilclaude.ai', {}));
  assert.ok(!originAllowed('', {}));
});
