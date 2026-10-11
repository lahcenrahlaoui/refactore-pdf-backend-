// index.js
const express = require('express');
const { chromium: playwrightChromium } = require('playwright-core');
const sparticuzChromium = require('@sparticuz/chromium-min');
const cors = require('cors');

const app = express();

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : '*';

const PDF_TIMEOUT_MS = Number(process.env.PDF_TIMEOUT_MS || 55000);
const MAX_PAYLOAD = process.env.MAX_PAYLOAD || '50mb';

const DEFAULT_CHROMIUM_REMOTE =
    'https://github.com/Sparticuz/chromium/releases/download/v131.0.0/chromium-v131.0.0-pack.tar';

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
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

let browserPromise = null;

async function getBrowser() {
    if (!browserPromise) {
        log('launching Chromium...');
        browserPromise = (async () => {
            const remotePath = process.env.CHROMIUM_REMOTE_EXEC_PATH || DEFAULT_CHROMIUM_REMOTE;
            log('Chromium remote tarball:', remotePath);

            const executablePath = await sparticuzChromium.executablePath(remotePath);
            log('Chromium extracted to:', executablePath);

            const browser = await playwrightChromium.launch({
                args: [
                    ...sparticuzChromium.args,
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--font-render-hinting=none',
                ],
                executablePath,
                headless: true,
            });

            log('Chromium launched, version:', browser.version());
            browser.on('disconnected', () => {
                log('Chromium disconnected — will relaunch');
                browserPromise = null;
            });
            return browser;
        })().catch((err) => {
            log('Chromium launch failed:', err.message);
            browserPromise = null;
            throw err;
        });
    }
    return browserPromise;
}

function buildContentDisposition(filename) {
    const rawName = (filename || 'proposal.pdf').replace(/[\\/:*?"<>|]/g, '').trim() || 'proposal.pdf';
    const asciiFallback = rawName.replace(/\.pdf$/i, '').replace(/[^\x20-\x7E]/g, '_').slice(0, 100) + '.pdf';
    const utf8Name = encodeURIComponent(rawName);
    return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`;
}

app.post('/api/generate-pdf', async (req, res) => {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    log(`PDF request: filename="${filename || 'proposal.pdf'}" htmlSize=${html.length}`);

    let context, page;
    const started = Date.now();

    try {
        const browser = await getBrowser();
        context = await browser.newContext();
        page = await context.newPage();

        page.setDefaultTimeout(PDF_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(PDF_TIMEOUT_MS);
        page.on('console', () => {});
        page.on('pageerror', () => {});

        await page.setContent(html, { waitUntil: 'networkidle', timeout: PDF_TIMEOUT_MS });

        try {
            await page.evaluate(async () => {
                if (document.fonts && document.fonts.ready) await document.fonts.ready;
            });
        } catch (_) {}

        await page.waitForTimeout(300);

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
        });

        await context.close();
        context = null; page = null;

        log(`PDF generated in ${Date.now() - started}ms, ${pdfBuffer.length} bytes`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdfBuffer);
    } catch (err) {
        log('PDF generation failed:', err.message);
        if (page) { try { await page.close(); } catch (_) {} }
        if (context) { try { await context.close(); } catch (_) {} }
        res.status(500).json({ error: (err && err.message) || 'PDF generation failed' });
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