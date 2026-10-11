// index.js
const express = require('express');
const cors = require('cors');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const app = express();

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : '*';

const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS || 45000);
const MAX_PAYLOAD = process.env.MAX_PAYLOAD || '4mb'; // Vercel body limit is ~4.5MB
const SETTLE_MS = Number(process.env.SETTLE_MS || 300);

// Optional hosted-browser fallback (Browserless / Browserbase).
// If set, we skip the bundled Chromium entirely — reliable on Vercel, no extraction needed.
const BROWSER_WS_ENDPOINT = process.env.BROWSER_WS_ENDPOINT || null;

// Arabic-capable fonts (the bundled Chromium only ships Latin fonts)
const FONT_URLS = [
    'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Regular.ttf',
    'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf/NotoSansArabic-Bold.ttf',
];

app.use(cors({
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
}));
app.use(express.json({ limit: MAX_PAYLOAD }));

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

app.get('/', (_req, res) => res.json({ service: 'pdf-server', status: 'ok' }));
app.get('/health', (_req, res) =>
    res.json({ ok: true, uptime: process.uptime() }),
);

// Graphics off ONCE, globally: faster cold start, not needed for PDFs.
chromium.setGraphicsMode = false;

let browserPromise = null;

async function createBrowser() {
    // Hosted browser path (Browserless, Browserbase, ...)
    if (BROWSER_WS_ENDPOINT) {
        log('connecting to hosted browser...');
        return puppeteer.connect({ browserWSEndpoint: BROWSER_WS_ENDPOINT });
    }

    // Local bundled Chromium path
    log('launching Chromium...');

    // Load fonts in PARALLEL, non-fatal, BEFORE launch (one extraction cycle)
    const fontResults = await Promise.allSettled(FONT_URLS.map((u) => chromium.font(u)));
    fontResults.forEach((r, i) => {
        if (r.status === 'fulfilled') log('Font loaded:', FONT_URLS[i].split('/').pop());
        else log('Font load failed (non-fatal):', FONT_URLS[i].split('/').pop(), r.reason && r.reason.message);
    });

    // Let the package extract its libs and set LD_LIBRARY_PATH itself.
    const executablePath = await chromium.executablePath();
    log('Chromium executable at:', executablePath);

    const browser = await puppeteer.launch({
        args: chromium.args,
        executablePath,
        headless: 'shell',
        // Explicit protocol timeout: Vercel kills the lambda before puppeteer's
        // default 180s, which surfaces as an unhelpful "Target closed" 500.
        protocolTimeout: PDF_TIMEOUT_MS + 15000,
    });

    log('Chromium launched, version:', await browser.version());
    return browser;
}

function getBrowser() {
    if (!browserPromise) {
        browserPromise = createBrowser()
            .then((browser) => {
                browser.on('disconnected', () => {
                    log('Browser disconnected — will relaunch next request');
                    browserPromise = null;
                });
                return browser;
            })
            .catch((err) => {
                log('Browser launch failed:', err && err.stack ? err.stack : err);
                browserPromise = null;
                throw err;
            });
    }
    return browserPromise;
}

function buildContentDisposition(filename) {
    const rawName = (filename || 'proposal.pdf')
        .replace(/[\\/:*?"<>|]/g, '').trim() || 'proposal.pdf';
    const base = rawName
        .replace(/\.pdf$/i, '').replace(/[^\x20-\x7E]/g, '_').slice(0, 90);
    const asciiFallback = `${base}.pdf`;
    const utf8Name = encodeURIComponent(rawName);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

app.post('/api/generate-pdf', async (req, res) => {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    log(`PDF request: filename="${filename || 'proposal.pdf'}" htmlSize=${html.length}`);

    let page = null;
    const started = Date.now();

    try {
        const browser = await getBrowser();
        page = await browser.newPage();

        page.setDefaultTimeout(PDF_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(PDF_TIMEOUT_MS);

        // IMPORTANT CHANGE: 'load' instead of 'networkidle0'.
        // networkidle0 waits for 500ms of zero network activity — a slow or
        // blocked external asset (fonts, analytics) hangs the whole render on
        // Vercel until timeout. 'load' fires as soon as the document is ready.
        try {
            await page.setContent(html, {
                waitUntil: 'load',
                timeout: PDF_TIMEOUT_MS,
            });
        } catch (e) {
            // A timeout here is often still salvageable — continue and try the PDF.
            log('setContent warning (continuing):', e.message);
        }

        // Wait for web fonts (Arabic/RTL) to actually be ready
        try {
            await page.evaluate(async () => {
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
            });
        } catch (_) {}

        if (SETTLE_MS > 0) {
            await new Promise((r) => setTimeout(r, SETTLE_MS));
        }

        const pdfBuffer = Buffer.from(
            await page.pdf({
                format: 'A4',
                printBackground: true,
                preferCSSPageSize: true,
                margin: { top: 0, right: 0, bottom: 0, left: 0 },
            }),
        );

        try { await page.close(); } catch (_) {}
        page = null;

        log(`PDF generated in ${Date.now() - started}ms, ${pdfBuffer.length} bytes`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdfBuffer);
    } catch (err) {
        log('PDF generation failed:', err && err.stack ? err.stack : err);
        if (page) { try { await page.close(); } catch (_) {} }
        res.status(500).json({
            error: (err && err.message ? err.message : 'PDF generation failed').slice(0, 500),
        });
    }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
    log('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, '0.0.0.0', () => {
        log(`PDF server listening on port ${PORT}`);
    });
}