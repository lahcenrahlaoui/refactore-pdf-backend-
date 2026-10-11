const express = require('express');
const cors = require('cors');
const config = require('./config');
const { log } = require('./logger');
const { diagnostics, envSnapshot } = require('./browser');
const { generatePdf, buildContentDisposition } = require('./pdf');
const { errorPayload } = require('./errors');

const app = express();

app.use(cors({
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-health-token'],
    credentials: false,
}));
app.use(express.json({ limit: config.maxPayload }));

function requireHealthToken(req, res, next) {
    const given = req.get('x-health-token') || req.query.token;
    if (!config.healthToken || given !== config.healthToken) {
        return res.status(403).json({ error: 'Forbidden. Set HEALTH_TOKEN and send it as x-health-token.' });
    }
    next();
}

function requireApiToken(req, res, next) {
    if (!config.apiToken) return next();
    if (req.get('authorization') !== `Bearer ${config.apiToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.get('/', (_req, res) => res.json({ service: 'pdf-server', status: 'ok' }));
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), ...diagnostics }));

// Full pipeline check: launch -> fonts -> Arabic render. Token-protected.
app.get('/health/deep', requireHealthToken, async (_req, res) => {
    const started = Date.now();
    try {
        const pdf = await generatePdf(
            '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>Hello مرحبا</h1></body></html>',
        );
        res.json({ ok: true, ms: Date.now() - started, pdfBytes: pdf.length });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, ms: Date.now() - started, ...errorPayload(err) });
    }
});

// Library/env debugging. Needs DEBUG=1 and the health token.
app.get('/health/env', requireHealthToken, (_req, res) => {
    if (!config.debug) return res.status(404).json({ error: 'Not found' });
    res.json(envSnapshot());
});

app.post('/api/generate-pdf', requireApiToken, async (req, res) => {
    const { html, filename } = req.body || {};
    if (!html || typeof html !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid "html" field' });
    }

    log(`PDF request: filename="${filename || 'proposal.pdf'}" htmlSize=${html.length}`);
    const started = Date.now();

    try {
        const pdfBuffer = await generatePdf(html);
        log(`PDF generated in ${Date.now() - started}ms, ${pdfBuffer.length} bytes`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', buildContentDisposition(filename));
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdfBuffer);
    } catch (err) {
        log('PDF generation failed:', err && err.stack ? err.stack : err);
        res.status(err.statusCode || 500).json(errorPayload(err));
    }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
    log('Unhandled error:', err.message);
    res.status(err.status || 500).json({ error: 'Internal server error' });
});

module.exports = app;