// 從 ../index.html 抽出標記 // <mobsim> … // </mobsim> 的區塊（怪物資料與 AI），產生 src/mobs.gen.js
//   npm run gen          重新產生
//   npm run gen -- --check   只檢查是否已是最新（npm test 也會檢查）
// index.html 仍是唯一來源（Artifact 需要單一檔案）；這裡只是原封不動地複製，再加上 export。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const SRC = join(here, '..', '..', 'index.html');
export const OUT = join(here, '..', 'src', 'mobs.gen.js');

// Worker 會用到的名稱（少了任何一個，產生時就會報錯）
export const EXPORTS = [
  'WORLD_W', 'WORLD_H', 'GROUND_Y', 'TOWN_X', 'ARENA_X', 'FROST_X', 'ICE_X', 'zoneL', 'zoneR', 'GRAV', 'PHYS',
  'rand', 'randi', 'clamp', 'approach',
  'MONSTERS', 'PLATFORMS', 'SPAWNS',
  'makeMonster', 'resetMonster', 'mobSig', 'landOn', 'mobStep', 'mobKnock', 'MSKILL', 'FLY_H',
];

export function generate(html = readFileSync(SRC, 'utf8')) {
  const lines = html.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let cur = null;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t === '// <mobsim>') {
      if (cur) throw new Error(`index.html 第 ${i + 1} 行：<mobsim> 區塊沒有結束就又開始`);
      cur = { start: i + 1, lines: [] };
    } else if (t === '// </mobsim>') {
      if (!cur) throw new Error(`index.html 第 ${i + 1} 行：多了一個 </mobsim>`);
      blocks.push(cur); cur = null;
    } else if (cur) cur.lines.push(line);
  });
  if (cur) throw new Error('index.html：<mobsim> 區塊沒有結束');
  if (!blocks.length) throw new Error('index.html 裡找不到 <mobsim> 區塊');
  const body = blocks.map((b, i) => `// ---- <mobsim> 區塊 ${i + 1} ----\n` + b.lines.join('\n')).join('\n\n');
  for (const name of EXPORTS) {
    if (!new RegExp(`\\b${name}\\b`).test(body)) throw new Error(`<mobsim> 區塊裡找不到 ${name}`);   // 真正有沒有定義，匯入時就會知道
  }
  return '// ⚠ 自動產生的檔案，請勿手動修改。來源：index.html 的 <mobsim> 區塊；重新產生：在 worker 資料夾執行 npm run gen\n' +
    '/* eslint-disable */\n' + body + '\n\nexport {\n  ' + EXPORTS.join(', ') + ',\n};\n';
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const out = generate();
  if (process.argv.includes('--check')) {
    let old = '';
    try { old = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { /* 還沒產生 */ }
    if (old !== out) { console.error('src/mobs.gen.js 不是最新的，請執行 npm run gen'); process.exit(1); }
    console.log('src/mobs.gen.js 是最新的');
  } else {
    writeFileSync(OUT, out);
    console.log('已產生 src/mobs.gen.js');
  }
}
