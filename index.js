// index.js
// Production PDF generation service for Render (Playwright + Docker).

const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');

const app = express();

// ---- Config ----
const PORT = process.env.PORT || 3000;

// Comma-separated list of allowed origins, e.g.
//   ALLOWED_ORIGINS=https://myapp.vercel.app,https://myapp.com
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : '*';

const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS || 60000);
const MAX_PAYLOAD = process.env.MAX_PAYLOAD || '50mb';

// ---- Middleware ----
app.use(
    cors({
        origin: ALLOWED_ORIGINS,
        methods: ['GET', 'POST', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        credentials: false,
    }),
);
app.use(express.json({ limit: MAX_PAYLOAD }));

// ---- Logging ----
function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

// ---- Health checks ----
app.get('/', (_req, res) => res.json({ service: 'pdf-server', status: 'ok' }));
app.get('/health', (_req, res) =>
    res.json({ ok: true, uptime: process.uptime() }),
);

// ---- Browser lifecycle (one instance, reused) ----
// Launching Chromium costs ~1-2s. On Render's free tier (0.1 CPU),
// keeping one warm instance dramatically improves latency.
let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        log('launching Chromium...');
        browserPromise = chromium
            .launch({
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage', // /dev/shm is tiny on Render
                    '--disable-gpu',
                    '--font-render-hinting=none', // better Arabic rendering
                ],
                // Playwright finds browsers at /ms-playwright automatically
                // in the official Docker image. No path config needed.
            })
            .then((b) => {
                log('Chromium launched, version:', b.version());
                b.on('disconnected', () => {
                    log('Chromium disconnected — will relaunch next request');
                    browserPromise = null;
                });
                return b;
            })
            .catch((err) => {
                log('Chromium launch failed:', err.message);
                browserPromise = null;
                throw err;
            });
    }
    return browserPromise;
}

// ---- Build a safe Content-Disposition header (RFC 5987) ----
function buildContentDisposition(filename) {
    const rawName =
        (filename || 'proposal.pdf')
            .replace(/[\\/:*?"<>|]/g, '')
            .trim() || 'proposal.pdf';

    const asciiFallback =
        rawName
            .replace(/\.pdf$/i, '')
            .replace(/[^\x20-\x7E]/g, '_')
            .slice(0, 100) + '.pdf';

    const utf8Name = encodeURIComponent(rawName);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

// ---- POST /api/generate-pdf ----
app.post('/api/generate-pdf', async (req, res) => {
    const { html, filename } = req.body || {};

    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    log(`PDF request: filename="${filename || 'proposal.pdf'}" htmlSize=${html.length}`);

    let context;
    let page;
    const started = Date.now();

    try {
        const browser = await getBrowser();

        // Isolated context per request (no cookie/state leaks between users).
        context = await browser.newContext();
        page = await context.newPage();

        page.setDefaultTimeout(PDF_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(PDF_TIMEOUT_MS);

        // Silence page logs.
        page.on('console', () => {});
        page.on('pageerror', () => {});

        await page.setContent(html, {
            waitUntil: 'networkidle',
            timeout: PDF_TIMEOUT_MS,
        });

        // Wait for webfonts (critical for Arabic typography).
        try {
            await page.evaluate(async () => {
                if (document.fonts && document.fonts.ready) {
                    await document.fonts.ready;
                }
            });
        } catch (_) { /* ignore */ }

        await page.waitForTimeout(300);

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
        });

        await context.close();
        context = null;
        page = null;

        log(`PDF generated in ${Date.now() - started}ms, ${pdfBuffer.length} bytes`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdfBuffer);
    } catch (err) {
        log('PDF generation failed:', err.message);
        if (page) {
            try { await page.close(); } catch (_) { /* ignore */ }
        }
        if (context) {
            try { await context.close(); } catch (_) { /* ignore */ }
        }
        res.status(500).json({
            error: (err && err.message) || 'PDF generation failed',
        });
    }
});

// ---- 404 ----
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ---- Global error handler ----
app.use((err, _req, res, _next) => {
    log('Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
});

// ---- Graceful shutdown (Render sends SIGTERM on redeploy) ----
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}, shutting down...`);
    try {
        if (browserPromise) {
            const b = await browserPromise;
            await b.close();
            log('Chromium closed');
        }
    } catch (_) { /* ignore */ }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (r) => log('unhandledRejection:', r));

// ---- Start ----
app.listen(PORT, '0.0.0.0', () => {
    log(`PDF server listening on port ${PORT}`);
    log(
        `Allowed origins: ${
            Array.isArray(ALLOWED_ORIGINS)
                ? ALLOWED_ORIGINS.join(', ')
                : ALLOWED_ORIGINS
        }`,
    );
    log(`PDF timeout: ${PDF_TIMEOUT_MS}ms`);
});