// scripts/fetch-fonts.js — run ONCE locally, then commit the fonts/ folder:
//   node scripts/fetch-fonts.js
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf';
const FILES = ['NotoSansArabic-Regular.ttf', 'NotoSansArabic-Bold.ttf'];
const DIR = path.join(__dirname, '..', 'fonts');

fs.mkdirSync(DIR, { recursive: true });
FILES.forEach((f) => {
    https
        .get(`${BASE}/${f}`, (res) => {
            if (res.statusCode !== 200) {
                console.error('FAILED', f, 'HTTP', res.statusCode);
                return;
            }
            const out = fs.createWriteStream(path.join(DIR, f));
            res.pipe(out);
            out.on('finish', () => console.log('saved', f));
        })
        .on('error', (e) => console.error('FAILED', f, e.message));
});