// Gera o índice musicas/playlist.json com todas as músicas da pasta "musicas".
// Use quando hospedar fora do GitHub Pages (ex.: Netlify), ou sempre que
// adicionar/remover músicas. No GitHub Pages NÃO precisa rodar isto — o app
// lista a pasta automaticamente.
//
// Como usar:  abra o terminal nesta pasta e rode:   node gerar-playlist.js
const fs   = require('fs');
const path = require('path');

const dir  = path.join(__dirname, 'musicas');
const exts = /\.(mp3|m4a|wav|ogg|aac|flac|opus|weba)$/i;

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
  console.log('Pasta "musicas/" criada. Coloque seus MP3 nela e rode de novo.');
}

const files = fs.readdirSync(dir)
  .filter(f => exts.test(f))
  .sort((a, b) => a.localeCompare(b, 'pt', { numeric: true }));

fs.writeFileSync(path.join(dir, 'playlist.json'), JSON.stringify(files, null, 2) + '\n');
console.log(`✓ playlist.json gerado com ${files.length} música(s):`);
files.forEach((f, i) => console.log(`   ${String(i + 1).padStart(2, '0')}. ${f}`));
