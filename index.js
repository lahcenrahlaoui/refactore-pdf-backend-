// server/index.js
// Plain Node.js (CommonJS) — no TypeScript syntax.
const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/generate-pdf', async (req, res) => {
    const { html, filename } = req.body;

    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();

        // Load the HTML and wait until network is idle (fonts, images loaded)
        await page.setContent(html, {
            waitUntil: 'networkidle0',
            timeout: 60000,
        });

        // Extra wait to make sure Arabic webfonts have finished rendering.
        try {
            await page.evaluate(() => {
                if (document.fonts && document.fonts.ready) {
                    return document.fonts.ready;
                }
                return Promise.resolve();
            });
        } catch (_) { /* ignore */ }

        await new Promise((r) => setTimeout(r, 1000));

        // Generate the PDF using Chrome's native print engine.
        // This produces REAL selectable / searchable text.
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
        });

        await browser.close();

        // ---- Build a safe, standards-compliant filename header ----
        // HTTP headers must be ASCII-only, so we cannot put Arabic
        // characters directly into Content-Disposition. RFC 5987 gives
        // us a way to send the real UTF-8 name alongside an ASCII fallback.
        const rawName =
            (filename || 'proposal.pdf')
                .replace(/[\\/:*?"<>|]/g, '')
                .trim() || 'proposal.pdf';

        // ASCII-only fallback (for very old browsers that don't support filename*)
        const asciiFallback =
            rawName
                .replace(/\.pdf$/i, '')
                .replace(/[^\x20-\x7E]/g, '_')
                .slice(0, 100) + '.pdf';

        // UTF-8 encoded version — modern browsers use this to save
        // the file with its real (e.g. Arabic) name.
        const utf8Name = encodeURIComponent(rawName);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Name}`,
        );
        res.setHeader('Content-Length', pdfBuffer.length);
        res.end(pdfBuffer);
    } catch (err) {
        console.error('[PDF] generation failed:', err);
        if (browser) {
            try { await browser.close(); } catch (_) { /* ignore */ }
        }
        res.status(500).json({ error: (err && err.message) || 'PDF generation failed' });
    }
});

app.listen(PORT, () => {
    console.log(`PDF server running on http://localhost:${PORT}`);
});