function errorPayload(err) {
    const message = err && err.message ? err.message : 'PDF generation failed';
    const payload = {
        error: message.slice(0, 800),
        type: err && err.name ? err.name : 'Error',
    };
    if (err && err.code) payload.code = err.code;

    if (/shared librar|libnss3|cannot open shared object/i.test(message)) {
        payload.hint = 'Chromium system libraries missing. Make sure @sparticuz/chromium is a recent version, Node is 22.x, and includeFiles has node_modules/@sparticuz/chromium/bin/**. Check /health/env (DEBUG=1).';
    } else if (/launch|executable|ENOENT/i.test(message)) {
        payload.hint = 'Chromium failed to start. Check includeFiles in vercel.json, or set BROWSER_WS_ENDPOINT to use Browserless/Browserbase.';
    } else if (/timeout/i.test(message)) {
        payload.hint = 'Render timed out. An external asset may be blocking; avoid heavy remote resources in the HTML.';
    } else if (/closed|disconnect|protocol|crashed|target/i.test(message)) {
        payload.hint = 'Browser crashed or was killed. Check memory and maxDuration in vercel.json.';
    }
    return payload;
}

module.exports = { errorPayload };