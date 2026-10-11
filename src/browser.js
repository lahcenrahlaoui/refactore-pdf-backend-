const fs = require('fs');
const path = require('path');
const config = require('./config');
const { log } = require('./logger');
const { registerSystemFonts } = require('./fonts');

const diagnostics = {
    node: process.version,
    platform: process.platform,
    hostedBrowser: Boolean(config.browserWsEndpoint),
    browser: { status: 'idle', attempts: 0, version: null, error: null },
};

let libs = null;
// Dynamic import works for both CJS and ESM builds of these packages.
async function loadLibs() {
    if (libs) return libs;
    const c = await import('@sparticuz/chromium');
    const p = await import('puppeteer-core');
    libs = { chromium: c.default || c, puppeteer: p.default || p };
    return libs;
}

async function createBrowser() {
    const { chromium, puppeteer } = await loadLibs();

    if (config.browserWsEndpoint) {
        log('connecting to hosted browser...');
        return puppeteer.connect({ browserWSEndpoint: config.browserWsEndpoint });
    }

    log('launching Chromium...');
    chromium.setGraphicsMode = false; // faster cold start; PDFs don't need WebGL
    await registerSystemFonts(chromium);

    // Extracts the binary AND the al2023 system libs (libnss3 etc.) into /tmp,
    // and updates LD_LIBRARY_PATH. Recent versions do this on Node 22.
    const executablePath = await chromium.executablePath();
    log('Chromium executable at:', executablePath, '| LD_LIBRARY_PATH:', process.env.LD_LIBRARY_PATH);

    return puppeteer.launch({
        args: chromium.args,
        defaultViewport: { width: 1280, height: 800 },
        executablePath,
        headless: 'shell',
        protocolTimeout: config.pdfTimeoutMs + 10000,
    });
}

let browserPromise = null;
let lastFailure = null; // { at, err } - avoids hammering a broken launch

function getBrowser() {
    if (lastFailure && Date.now() - lastFailure.at < 5000) {
        return Promise.reject(lastFailure.err);
    }
    if (!browserPromise) {
        diagnostics.browser.attempts += 1;
        diagnostics.browser.status = 'launching';
        browserPromise = createBrowser()
            .then(async (browser) => {
                diagnostics.browser.status = 'ready';
                diagnostics.browser.error = null;
                lastFailure = null;
                try { diagnostics.browser.version = await browser.version(); } catch (_) {}
                log('browser ready:', diagnostics.browser.version);
                browser.on('disconnected', () => {
                    log('browser disconnected - will relaunch next request');
                    diagnostics.browser.status = 'disconnected';
                    browserPromise = null;
                });
                return browser;
            })
            .catch((err) => {
                log('browser launch failed:', err && err.stack ? err.stack : err);
                diagnostics.browser.status = 'error';
                diagnostics.browser.error = String((err && err.message) || err).slice(0, 300);
                lastFailure = { at: Date.now(), err };
                browserPromise = null;
                throw err;
            });
    }
    return browserPromise;
}

async function resetBrowser() {
    const p = browserPromise;
    browserPromise = null;
    if (p) {
        try { const b = await p; await b.close(); } catch (_) {}
    }
}

// Safe-to-share snapshot for debugging library problems on Vercel.
function envSnapshot() {
    const ls = (p) => { try { return fs.readdirSync(p).slice(0, 25); } catch (e) { return `ERR: ${e.code || e.message}`; } };
    let binDir;
    try {
        const pkgMain = require.resolve('@sparticuz/chromium');
        let dir = path.dirname(pkgMain);
        while (dir !== path.dirname(dir) && !fs.existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
        binDir = ls(path.join(dir, 'bin'));
    } catch (e) {
        binDir = `ERR: ${e.message}`;
    }
    return {
        AWS_EXECUTION_ENV: process.env.AWS_EXECUTION_ENV,
        AWS_LAMBDA_JS_RUNTIME: process.env.AWS_LAMBDA_JS_RUNTIME,
        LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
        tmp: ls('/tmp'),
        al2023Lib: ls('/tmp/al2023/lib'),
        binDir,
    };
}

module.exports = { getBrowser, resetBrowser, diagnostics, envSnapshot };