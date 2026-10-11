// index.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const app = express();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
    allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
        : '*',
    pdfTimeoutMs: Number(process.env.PDF_TIMEOUT_MS || 45000),
    maxPayload: process.env.MAX_PAYLOAD || '4mb', // Vercel body limit is ~4.5MB
    settleMs: Number(process.env.SETTLE_MS || 300),
    // Optional hosted-browser fallback (Browserless / Browserbase).
    // If set, the bundled Chromium is never launched.
    browserWsEndpoint: process.env.BROWSER_WS_ENDPOINT || null,
};

// ---------------------------------------------------------------------------
// Logging + diagnostics
// ---------------------------------------------------------------------------

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

// Surfaced via /health so a failing Vercel deploy can be diagnosed externally.
const diagnostics = {
    node: process.version,
    platform: process.platform,
    hostedBrowser: Boolean(CONFIG.browserWsEndpoint),
    browser: { status: 'idle', attempts: 0, version: null, error: null },
};

// ---------------------------------------------------------------------------
// Arabic fonts: vendored files first (no network at runtime), URLs as fallback
// ---------------------------------------------------------------------------

const FONT_DIR = path.join(__dirname, 'fonts');
const FONT_NAMES = ['NotoSansArabic-Regular.ttf', 'NotoSansArabic-Bold.ttf'];
const FONT_URL_BASE = 'https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansArabic/hinted/ttf';

async function loadFonts() {
    const results = await Promise.allSettled(
        FONT_NAMES.map(async (name) => {
            const localPath = path.join(FONT_DIR, name);
            if (fs.existsSync(localPath)) {
                return chromium.font(localPath); // local file => zero network at runtime
            }
            return chromium.font(`${FONT_URL_BASE}/${name}`); // fallback
        }),
    );
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') log('Font ready:', FONT_NAMES[i]);
        else log('Font load failed (non-fatal):', FONT_NAMES[i], r.reason && r.reason.message);
    });
}

// ---------------------------------------------------------------------------
// Browser lifecycle (launch once, reuse across warm invocations)
// ---------------------------------------------------------------------------

// Graphics off: faster cold start, PDFs don't need WebGL.
chromium.setGraphicsMode = false;

let browserPromise = null;

async function createBrowser() {
    if (CONFIG.browserWsEndpoint) {
        log('connecting to hosted browser...');
        return puppeteer.connect({ browserWSEndpoint: CONFIG.browserWsEndpoint });
    }

    log('launching Chromium...');
    await loadFonts();

    const executablePath = await chromium.executablePath();
    log('Chromium executable at:', executablePath);

    // Officially recommended launch shape for @sparticuz/chromium + puppeteer-core.
    // chromium.headless === 'shell' here because graphics mode is off.
    return puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath,
        headless: chromium.headless,
        // Must stay below the platform limit, or Vercel kills the lambda first
        // and the client only sees an opaque "Target closed".
        protocolTimeout: CONFIG.pdfTimeoutMs + 15000,
    });
}

function getBrowser() {
    if (!browserPromise) {
        diagnostics.browser.attempts += 1;
        diagnostics.browser.status = 'launching';
        browserPromise = createBrowser()
            .then(async (browser) => {
                diagnostics.browser.status = 'ready';
                diagnostics.browser.error = null;
                try {
                    diagnostics.browser.version = await browser.version();
                } catch (_) {}
                log('browser ready:', diagnostics.browser.version);
                browser.on('disconnected', () => {
                    log('browser disconnected — will relaunch next request');
                    diagnostics.browser.status = 'disconnected';
                    browserPromise = null;
                });
                return browser;
            })
            .catch((err) => {
                log('browser launch failed:', err && err.stack ? err.stack : err);
                diagnostics.browser.status = 'error';
                diagnostics.browser.error = String(err && err.message || err).slice(0, 300);
                browserPromise = null;
                throw err;
            });
    }
    return browserPromise;
}

// One retry: if the warm browser died between requests, the next attempt
// relaunches from scratch (the disconnect handler reset browserPromise).
async function acquireBrowser() {
    try {
        return await getBrowser();
    } catch (firstErr) {
        log('first browser acquisition failed, retrying once:', firstErr.message);
        return getBrowser();
    }
}

// ---------------------------------------------------------------------------
// PDF rendering
// ---------------------------------------------------------------------------

async function renderPdf(browser, html) {
    const page = await browser.newPage();
    try {
        page.setDefaultTimeout(CONFIG.pdfTimeoutMs);
        page.setDefaultNavigationTimeout(CONFIG.pdfTimeoutMs);

        // 'load' (NOT 'networkidle0'): a slow or blocked external asset
        // (font, tracker, image) would otherwise hang the render until timeout.
        // A timeout here is still salvageable, so we log and continue.
        try {
            await page.setContent(html, { waitUntil: 'load', timeout: CONFIG.pdfTimeoutMs });
        } catch (e) {
            log('setContent warning (continuing):', e.message);
        }

        // Wait for web fonts (Arabic/RTL) to actually finish loading.
        try {
            await page.evaluate(async () => {
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
            });
        } catch (_) {}

        if (CONFIG.settleMs > 0) {
            await new Promise((r) => setTimeout(r, CONFIG.settleMs));
        }

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

function buildContentDisposition(filename) {
    const rawName = (filename || 'proposal.pdf')
        .replace(/[\\/:*?"<>|]/g, '').trim() || 'proposal.pdf';
    const base = rawName.replace(/\.pdf$/i, '').replace(/[^\x20-\x7E]/g, '_').slice(0, 90);
    const asciiFallback = `${base}.pdf`;
    const utf8Name = encodeURIComponent(rawName);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

// Structured error: the NEXT failure must be diagnosable from the client alone.
function errorPayload(err) {
    const message = err && err.message ? err.message : 'PDF generation failed';
    const payload = {
        error: message.slice(0, 800),
        type: err && err.name ? err.name : 'Error',
    };
    if (err && err.code) payload.code = err.code;

    if (/launch|executable|ENOENT|shared libraries|cannot open shared object/i.test(message)) {
        payload.hint = 'Chromium failed to start. Check includeFiles in vercel.json, or set BROWSER_WS_ENDPOINT to use Browserless/Browserbase.';
    } else if (/timeout/i.test(message)) {
        payload.hint = 'Render timed out. An external asset may be blocking; avoid heavy remote resources in the HTML.';
    } else if (/closed|disconnect|protocol|crashed|target/i.test(message)) {
        payload.hint = 'Browser crashed or was killed. Check memory (1024 MB) and maxDuration (60s) in vercel.json; cold starts also count toward the limit.';
    }
    return payload;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use(cors({
    origin: CONFIG.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
}));
app.use(express.json({ limit: CONFIG.maxPayload }));

app.get('/', (_req, res) => res.json({ service: 'pdf-server', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), ...diagnostics }));

// Deep health: actually generates a PDF with Arabic text on Vercel.
// The single best way to verify the whole pipeline (launch → fonts → RTL render).
app.get('/health/deep', async (_req, res) => {
    const started = Date.now();
    try {
        const browser = await acquireBrowser();
        const pdf = await renderPdf(browser, '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Hello مرحبا</h1></body></html>');
        res.json({ ok: true, ms: Date.now() - started, pdfBytes: pdf.length });
    } catch (err) {
        res.status(500).json({ ok: false, ms: Date.now() - started, ...errorPayload(err) });
    }
});

app.post('/api/generate-pdf', async (req, res) => {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    log(`PDF request: filename="${filename || 'proposal.pdf'}" htmlSize=${html.length}`);
    const started = Date.now();

    try {
        const browser = await acquireBrowser();
        const pdfBuffer = await renderPdf(browser, html);

        log(`PDF generated in ${Date.now() - started}ms, ${pdfBuffer.length} bytes`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdfBuffer);
    } catch (err) {
        log('PDF generation failed:', err && err.stack ? err.stack : err);
        res.status(500).json(errorPayload(err));
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