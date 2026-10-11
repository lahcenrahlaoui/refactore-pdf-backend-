const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
};

module.exports = {
    allowedOrigins: process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
        : '*',
    // Keep timeout + 10s below Vercel maxDuration (60s) so we fail with a clear error.
    pdfTimeoutMs: num(process.env.PDF_TIMEOUT_MS, 40000),
    maxPayload: process.env.MAX_PAYLOAD || '4mb', // Vercel body limit ~4.5MB
    settleMs: num(process.env.SETTLE_MS, 300),
    maxConcurrent: num(process.env.MAX_CONCURRENT, 2),
    browserWsEndpoint: process.env.BROWSER_WS_ENDPOINT || null, // Browserless/Browserbase fallback
    apiToken: process.env.API_TOKEN || null,       // optional: protects /api/generate-pdf
    healthToken: process.env.HEALTH_TOKEN || null, // required to use /health/deep and /health/env
    debug: process.env.DEBUG === '1',
    allowFontDownload: process.env.ALLOW_FONT_DOWNLOAD === '1',
    blockPrivateNetwork: process.env.BLOCK_PRIVATE_NETWORK !== '0', // SSRF protection, on by default
};