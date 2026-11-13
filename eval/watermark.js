#!/usr/bin/env node
// /watermark: find, and with --fix remove, the invisible and odd characters
// that cleanModelText strips from model answers (zero-width characters, soft
// hyphens, direction controls, Unicode tag characters, no-break and other
// unusual spaces). It runs the exact function from ai-council.js, read
// between its clean-text markers, so the command and the API never differ.
//
//   node eval/watermark.js <file>...           report only
//   node eval/watermark.js --fix <file>...     clean the files in place
//   echo "text" | node eval/watermark.js -     read stdin, print cleaned text
//
// Exit code 1 when anything was found (report mode), so it can gate a check.

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'netlify', 'functions', 'ai-council.js');
const fnSrc = (fs.readFileSync(SRC, 'utf8')
  .match(/\/\* clean-text:start \*\/([\s\S]*?)\/\* clean-text:end \*\//) || [])[1];
if (!fnSrc) { console.error('cleanModelText markers not found in ai-council.js'); process.exit(2); }
const cleanModelText = new Function(fnSrc + '\nreturn cleanModelText;')();

const NAMES = {
  0x00A0: 'no-break space', 0x00AD: 'soft hyphen', 0x200B: 'zero-width space',
  0x200C: 'zero-width non-joiner', 0x200D: 'zero-width joiner', 0x200E: 'left-to-right mark',
  0x200F: 'right-to-left mark', 0x202F: 'narrow no-break space', 0x2028: 'line separator',
  0x2029: 'paragraph separator', 0x2060: 'word joiner', 0xFEFF: 'byte-order mark',
};
const nameOf = cp => NAMES[cp]
  || (cp >= 0xE0000 && cp <= 0xE007F ? 'tag character'
    : cp >= 0x202A && cp <= 0x202E || cp >= 0x2066 && cp <= 0x2069 ? 'direction control'
    : cp >= 0x2000 && cp <= 0x200A ? 'unusual space'
    : cp < 0x20 || cp >= 0x7F && cp <= 0x9F ? 'control character' : 'invisible character');

// Which characters cleanModelText changes, with line numbers.
function findings(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const ch of line) {
      if (ch === '\r' || ch === '\t') continue;
      if (cleanModelText(ch) !== ch) {
        const cp = ch.codePointAt(0);
        out.push({ line: i + 1, code: 'U+' + cp.toString(16).toUpperCase().padStart(4, '0'), name: nameOf(cp) });
      }
    }
  });
  return out;
}

const args = process.argv.slice(2);
const fix = args.includes('--fix');
const files = args.filter(a => a !== '--fix');

if (!files.length) {
  console.log('Usage: node eval/watermark.js [--fix] <file>...   (or - for stdin)');
  process.exit(2);
}

if (files.length === 1 && files[0] === '-') {
  const text = fs.readFileSync(0, 'utf8');
  const found = findings(text);
  process.stdout.write(cleanModelText(text));
  console.error(`\n${found.length} character(s) cleaned`);
  process.exit(0);
}

let total = 0;
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const found = findings(text);
  total += found.length;
  if (!found.length) { console.log(`${file}: clean`); continue; }
  const byKind = {};
  found.forEach(f => { const k = `${f.code} ${f.name}`; (byKind[k] = byKind[k] || []).push(f.line); });
  console.log(`${file}: ${found.length} character(s)`);
  for (const [k, lines] of Object.entries(byKind)) {
    const shown = [...new Set(lines)].slice(0, 10).join(', ');
    console.log(`  ${k} — line ${shown}${new Set(lines).size > 10 ? ', …' : ''}`);
  }
  if (fix) { fs.writeFileSync(file, cleanModelText(text)); console.log('  fixed'); }
}
process.exit(total && !fix ? 1 : 0);
