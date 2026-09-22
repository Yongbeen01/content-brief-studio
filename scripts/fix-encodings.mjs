// scripts/ 의 인코딩 규칙을 맞춘다 (CLAUDE.md "인코딩 규칙"). 스크립트를 고친 뒤 한 번 돌린다.
//   node scripts/fix-encodings.mjs
//   - launch.ps1 · install-shortcut.ps1 : UTF-8 BOM + CRLF (-File 로 실행 → PowerShell 5.1 한글)
//   - install.ps1                        : BOM 없음 (irm | iex 가 BOM 을 명령으로 읽는다)
//   - *.bat · *.vbs                      : ASCII + CRLF (cmd.exe 는 OEM 코드페이지로 읽는다)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
const strip = (s) => s.replace(/^﻿/, '');

for (const f of ['launch.ps1', 'install-shortcut.ps1']) {
  const p = path.join(dir, f);
  fs.writeFileSync(p, `﻿${crlf(strip(fs.readFileSync(p, 'utf8')))}`, 'utf8');
}
{
  const p = path.join(dir, 'install.ps1');
  fs.writeFileSync(p, strip(fs.readFileSync(p, 'utf8')), 'utf8');
}
for (const f of fs.readdirSync(dir).filter((n) => /\.(bat|vbs)$/i.test(n))) {
  const p = path.join(dir, f);
  const s = strip(fs.readFileSync(p, 'utf8'));
  if (/[^\x00-\x7f]/.test(s)) throw new Error(`${f} 에 ASCII 가 아닌 글자가 있습니다`);
  fs.writeFileSync(p, crlf(s), 'ascii');
}
console.log('scripts 인코딩을 맞췄습니다.');
