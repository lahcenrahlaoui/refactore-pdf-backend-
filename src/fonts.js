const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log } = require('./logger');

const FONT_DIR = path.join(__dirname, '..', 'fonts');
const FONTS = [
    { file: 'NotoSansArabic-Regular.ttf', weight: 400 },
    { file: 'NotoSansArabic-Bold.ttf', weight: 700 },
];
const FONT_URL_BASE = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf';

// Register fonts with the system (fontconfig) too. Non-fatal: the data-URI
// embedding below is what really guarantees Arabic renders correctly.
async function registerSystemFonts(chromium) {
    const results = await Promise.allSettled(
        FONTS.map(async ({ file }) => {
            const local = path.join(FONT_DIR, file);
            if (fs.existsSync(local)) return chromium.font(local);
            if (config.allowFontDownload) return chromium.font(`${FONT_URL_BASE}/${file}`);
            throw new Error(`missing ${file}`);
        }),
    );
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') log('System font ready:', FONTS[i].file);
        else log('System font skipped (non-fatal):', FONTS[i].file, r.reason && r.reason.message);
    });
}

// Embedded @font-face rules (base64) - no fontconfig, no network.
let cachedCss;
function fontCss() {
    if (cachedCss !== undefined) return cachedCss;
    const rules = [];
    for (const { file, weight } of FONTS) {
        const p = path.join(FONT_DIR, file);
        if (!fs.existsSync(p)) continue;
        const b64 = fs.readFileSync(p).toString('base64');
        rules.push(
            `@font-face{font-family:'Noto Sans Arabic';font-weight:${weight};font-style:normal;` +
            `src:url(data:font/ttf;base64,${b64}) format('truetype');}`,
        );
    }
    cachedCss = rules.length
        ? rules.join('') + `html{font-family:'Noto Sans Arabic',sans-serif;}`
        : '';
    if (!cachedCss) log('No vendored fonts found in /fonts. Run: npm run fetch-fonts');
    return cachedCss;
}

// Inject at the very top of <head> so user CSS still wins.
function withFonts(html) {
    const css = fontCss();
    if (!css) return html;
    const tag = `<style>${css}</style>`;
    if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
    return tag + html;
}

module.exports = { registerSystemFonts, withFonts };