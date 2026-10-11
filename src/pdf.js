const config = require('./config');
const { log } = require('./logger');
const { getBrowser, resetBrowser } = require('./browser');
const { withFonts } = require('./fonts');

// --- SSRF protection: block requests to internal networks from user HTML ---
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|.*\.(internal|local|localhost)$)/i;

function isBlockedUrl(raw) {
    let u;
    try { u = new URL(raw); } catch (_) { return true; }
    if (['data:', 'about:', 'blob:'].includes(u.protocol)) return false;
    if (!['http:', 'https:'].includes(u.protocol)) return true;
    return config.blockPrivateNetwork && PRIVATE_HOST.test(u.hostname);
}

async function renderPdf(browser, html) {
    const page = await browser.newPage();
    try {
        page.setDefaultTimeout(config.pdfTimeoutMs);
        page.setDefaultNavigationTimeout(config.pdfTimeoutMs);

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (req.isInterceptResolutionHandled()) return;
            if (isBlockedUrl(req.url())) {
                log('blocked request:', req.url().slice(0, 120));
                req.abort('blockedbyclient');
            } else {
                req.continue();
            }
        });

        // 'load', not 'networkidle0': a slow external asset must not hang the render.
        try {
            await page.setContent(withFonts(html), { waitUntil: 'load', timeout: config.pdfTimeoutMs });
        } catch (e) {
            log('setContent warning (continuing):', e.message);
        }

        try {
            await page.evaluate(async () => {
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
            });
        } catch (_) {}

        if (config.settleMs > 0) await new Promise((r) => setTimeout(r, config.settleMs));

        return Buffer.from(
            await page.pdf({
                format: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
            }),
        );
    } finally {
        try { await page.close(); } catch (_) {}
    }
}

const TRANSIENT = /Target closed|Session closed|Connection closed|disconnected|Protocol error|crashed/i;
let active = 0;

async function attempt(html) {
    const browser = await getBrowser();
    return renderPdf(browser, html);
}

async function generatePdf(html) {
    if (active >= config.maxConcurrent) {
        const e = new Error('Server busy, please retry shortly');
        e.statusCode = 503;
        throw e;
    }
    active += 1;
    try {
        try {
            return await attempt(html);
        } catch (err) {
            // Retry ONLY if a warm browser died. Launch failures are permanent: no retry.
            if (TRANSIENT.test(String(err && err.message))) {
                log('transient browser error, relaunching once:', err.message);
                await resetBrowser();
                return await attempt(html);
            }
            throw err;
        }
    } finally {
        active -= 1;
    }
}

function buildContentDisposition(filename) {
    const rawName = (filename || 'proposal.pdf').replace(/[\\/:*?"<>|]/g, '').trim() || 'proposal.pdf';
    const base = rawName.replace(/\.pdf$/i, '').replace(/[^\x20-\x7E]/g, '_').slice(0, 90);
    return `attachment; filename="${base}.pdf"; filename*=UTF-8''${encodeURIComponent(rawName)}`;
}

module.exports = { generatePdf, buildContentDisposition };