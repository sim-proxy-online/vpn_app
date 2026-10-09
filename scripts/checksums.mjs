#!/usr/bin/env node
/**
 * Генерирует SHA256SUMS.txt для файлов релиза.
 *
 *   node scripts/checksums.mjs <файл...>            # печатает хеши в консоль
 *   node scripts/checksums.mjs -o SHA256SUMS.txt <файл...>
 *
 * Запускать ТОЛЬКО после подписи файлов: подпись меняет содержимое,
 * и хеши «до подписи» у пользователя не сойдутся. Отсюда порядок в
 * release-windows.yml: сначала SignPath, потом checksums.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

const args = process.argv.slice(2);
let out = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o' || args[i] === '--out') out = args[++i];
  else files.push(args[i]);
}
if (files.length === 0) {
  console.error('usage: checksums.mjs [-o SHA256SUMS.txt] <file...>');
  process.exit(2);
}

const lines = [];
for (const f of files) {
  const hash = createHash('sha256').update(readFileSync(f)).digest('hex');
  // Формат — как у sha256sum: <hash>  <имя> (два пробела), чтобы `sha256sum -c` принимал.
  lines.push(`${hash}  ${basename(f)}`);
}
const text = lines.join('\n') + '\n';
if (out) {
  writeFileSync(out, text);
  console.log(`written: ${out} (${lines.length} files)`);
} else {
  process.stdout.write(text);
}
