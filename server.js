const express = require('express');
const dotenv = require('dotenv');
const path = require('node:path');
dotenv.config();

const { createAi, describeAiError } = require('./ai');
const communityRoutes = require('./community');
const { securityHeaders, limit, aiDailyCap } = require('./security');

const app = express();
app.disable('x-powered-by');
// Behind a host like Render or Railway, trust its proxy so rate limits see real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
app.use(securityHeaders);

// Health check for the host: answers only when the app and database are working.
app.get('/healthz', (req, res) => {
    try {
        communityRoutes.ping();
        res.set('Cache-Control', 'no-store').json({ ok: true });
    } catch (error) {
        res.status(503).json({ ok: false });
    }
});

// Only new reports carry photos (up to four, compressed, as base64); everything else stays small.
const reportJson = express.json({ limit: '14mb' });
const smallJson = express.json({ limit: '64kb' });
const photoRoute = (req) => req.method === 'POST' && (req.path === '/api/issues' || req.path === '/api/cony/photo' || /^\/api\/issues\/[^/]+\/after-photos$/.test(req.path));
app.use((req, res, next) => (photoRoute(req) ? reportJson : smallJson)(req, res, next));

// Shared report links: /r/<id> shows a preview card in texts and social posts, then opens the report.
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
app.get('/r/:id', limit({ name: 'share-page', max: 120, windowMs: 60 * 1000 }), (req, res) => {
    const share = communityRoutes.sharePreview(req.params.id);
    if (!share) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
    const title = `${share.title} · Sidewalk`;
    const description = `${share.supporters} of ${share.goal} neighbors backing this in ${share.area}. ${share.description}`.slice(0, 280);
    const target = `/?issue=${encodeURIComponent(share.id)}#report`;
    res.set('Cache-Control', 'public, max-age=300').type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Sidewalk">
<meta property="og:title" content="${escapeHtml(share.title)}"><meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(share.url)}"><meta property="og:image" content="${escapeHtml(share.image)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${escapeHtml(target)}">
<link rel="icon" href="/icon-192.png"><link rel="stylesheet" href="/style.css">
</head><body class="legal-page"><main style="padding:40px 20px;text-align:center"><p>Opening <a href="${escapeHtml(target)}">${escapeHtml(share.title)}</a> on Sidewalk…</p></main></body></html>`);
});

// Printable council packet for one report.
app.get('/packet/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'packet.html')));

// Policy pages at clean addresses: /privacy, /terms, /ai, /guidelines
for (const page of ['privacy', 'terms', 'ai', 'guidelines', 'data']) {
    app.get(`/${page}`, (req, res) => res.sendFile(path.join(__dirname, 'public', `${page}.html`)));
}

// Serves all files inside your public folder (index.html, style.css, app.js)
app.use(express.static('public'));
// The map library is served from this site (not a CDN), so blocked or slow CDNs can't break the map.
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist'), { maxAge: '7d' }));
app.use('/vendor/leaflet-heat', express.static(path.join(__dirname, 'node_modules', 'leaflet.heat', 'dist')));
// A broad per-IP ceiling on all API traffic; individual routes have tighter limits.
app.use('/api', limit({ name: 'api', max: 600, windowMs: 5 * 60 * 1000, message: 'Too many requests from your network. Please slow down and try again in a few minutes.' }));
app.use('/api', communityRoutes);

// Keep AI keys on the server; never send them to the browser.
const ai = createAi();
app.locals.ai = ai;
console.log(ai ? `AI assistant: ${ai.provider} (${ai.model})` : 'AI assistant: off (set GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)');

const aiBurst = (name, max) => limit({ name, max, windowMs: 10 * 60 * 1000, message: 'You’re sending messages quickly. Please wait a few minutes and try again.' });

app.post('/api/convert', aiBurst('convert', 10), aiDailyCap, async (req, res) => {
    const { message, location = '' } = req.body || {};
    if (typeof message !== 'string' || message.trim().length < 10 || message.length > 2000) {
        return res.status(400).json({ error: 'Describe the issue in 10 to 2,000 characters.' });
    }
    if (typeof location !== 'string' || location.length > 160) {
        return res.status(400).json({ error: 'Location must be 160 characters or fewer.' });
    }
    if (!ai) return res.status(503).json({ error: 'The AI converter is not configured. Add GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to the server environment.' });

    try {
        const draft = await ai.generateJson({
            system: 'You help residents turn informal infrastructure complaints into clear, respectful public works requests. Preserve the user’s facts. Never invent addresses, laws, code violations, agency names, or injuries. Do not claim the request was submitted or legally verified. Assign urgency based only on described risk: Routine, Elevated, or Urgent. For immediate danger, say to contact emergency services separately.',
            schema: {
                type: 'object',
                properties: {
                    title: { type: 'string' },
                    category: { type: 'string', enum: ['Street safety', 'Accessibility', 'Parks & public space', 'Street lighting', 'Other'] },
                    urgency: { type: 'string', enum: ['Routine', 'Elevated', 'Urgent'] },
                    summary: { type: 'string' },
                    emailSubject: { type: 'string' },
                    emailBody: { type: 'string' },
                },
                required: ['title', 'category', 'urgency', 'summary', 'emailSubject', 'emailBody'],
            },
            prompt: `Location provided by user: ${location.trim() || 'Not provided'}\n\nResident's description:\n${message.trim()}`,
        });
        if (!draft.title || !draft.emailBody) return res.status(502).json({ error: 'The AI returned an incomplete draft. Please try again.' });
        res.json({ draft });
    } catch (error) {
        console.error('Civic converter failed:', error.message);
        const friendly = describeAiError(error);
        if (friendly) return res.status(503).json({ error: friendly });
        res.status(502).json({ error: 'Could not create a formal draft. Please try again.' });
    }
});

// API endpoint for the civic assistant.
app.post('/api/chat', aiBurst('chat', 20), aiDailyCap, async (req, res) => {
    const { message, history } = req.body || {};

    if (typeof message !== 'string' || !message.trim() || message.length > 2000) {
        return res.status(400).json({ error: 'Enter a message up to 2,000 characters.' });
    }

    if (!ai) {
        return res.status(503).json({ error: 'The AI assistant is not configured. Add GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to the server environment.' });
    }

    const priorMessages = Array.isArray(history)
        ? history
            .filter((entry) => entry && ['user', 'model'].includes(entry.role) && typeof entry.text === 'string')
            .slice(-12)
            .map((entry) => ({ role: entry.role, text: entry.text.slice(0, 2000) }))
        : [];

    const stream = ai.chatStream({
        system: 'You are Cony, Sidewalk\'s friendly traffic-cone helper: upbeat, warm, and encouraging, but always practical and to the point. You never use cone puns more than once in a conversation. You are a guide to local infrastructure reporting in North and South Carolina. Help residents describe issues clearly, understand common civic reporting steps, and draft concise messages. Do not claim to submit reports, contact officials, verify local laws, or know agency contacts unless the user provides that information. Ask a clarifying question when location or details matter. Be transparent when uncertain. Never state phone numbers, email addresses, or web addresses unless the user gave them; instead tell the user where to look, such as their city or county website or 311 line. Write in plain text for a small chat bubble: no Markdown, no headings, no tables, no bold or asterisks, and no emoji. If the resident writes in another language, reply in that language. Keep replies under 120 words; use short numbered steps (1. 2. 3.) only when giving steps.',
        history: priorMessages,
        message: message.trim(),
    });

    // Wait for the first words before answering, so setup errors (bad key, rate limit)
    // still come back as a normal error message.
    let step;
    try {
        step = await stream.next();
    } catch (error) {
        console.error('AI assistant failed:', error.message);
        const friendly = describeAiError(error);
        if (friendly) return res.status(503).json({ error: friendly });
        return res.status(502).json({ error: 'Could not get a reply from the AI service. Please try again shortly.' });
    }
    if (step.done) return res.status(502).json({ error: 'The assistant returned an empty response. Please try again.' });

    // Stream the reply as newline-separated JSON: {"delta":"..."} ... then {"done":true}.
    res.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    let clientGone = false;
    res.on('close', () => { if (!res.writableEnded) clientGone = true; });
    const send = (event) => res.write(`${JSON.stringify(event)}\n`);
    try {
        for (; !step.done && !clientGone; step = await stream.next()) send({ delta: step.value });
        if (clientGone) await stream.return?.();
        else send({ done: true });
    } catch (error) {
        console.error('AI assistant stream failed:', error.message);
        send({ error: describeAiError(error) || 'The reply was cut off. Please try again.' });
    }
    res.end();
});

// ---------- Cony fills in reports: from a photo, a voice note, or rough text in any language ----------
const REPORT_FIELDS = {
    category: { type: 'string', enum: ['safety', 'access', 'lighting', 'parks', 'other'] },
    title: { type: 'string' },
    description: { type: 'string' },
};
const REPORT_RULES = 'Categories: safety = street safety (potholes, crosswalks, signs, traffic hazards, broken sidewalks that are a tripping hazard); access = accessibility (curb ramps, blocked or missing sidewalks, wheelchair barriers); lighting = streetlights; parks = parks and public spaces (trash, benches, playgrounds, overgrowth); other = anything else. The title is at most 60 characters, plain, specific, and in English, like "Deep pothole in the right lane". The description is 1 to 3 short sentences in English, at most 350 characters, saying what is wrong and who it affects. Never invent a street name, address, size, injury, or how long it has been there unless the resident said so. Never mention people, faces, or license plates.';
const cleanReport = (draft) => ({
    category: REPORT_FIELDS.category.enum.includes(draft.category) ? draft.category : 'other',
    title: String(draft.title || '').replace(/\s+/g, ' ').trim().slice(0, 70),
    description: String(draft.description || '').trim().slice(0, 400),
});
function aiFailure(res, label, error) {
    console.error(`${label} failed:`, error.message);
    const friendly = describeAiError(error);
    if (friendly) return res.status(503).json({ error: friendly });
    res.status(502).json({ error: 'Cony couldn’t do that just now. Please try again, or fill in the form yourself.' });
}
const needAi = (req, res, next) => (ai ? next() : res.status(503).json({ error: 'Cony is off on this server. Fill in the form yourself for now.' }));

app.post('/api/cony/photo', aiBurst('cony-photo', 8), needAi, aiDailyCap, async (req, res) => {
    const photo = req.body?.photo;
    if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 3_000_000) {
        return res.status(400).json({ error: 'Send one JPEG, PNG, or WebP photo under 2 MB.' });
    }
    try {
        const draft = await ai.describeImage({
            system: `You are Cony, Sidewalk's helper. A resident took a photo of a problem in a public street, sidewalk, or park in North or South Carolina. Fill in a report from what is clearly visible. ${REPORT_RULES} Set isStreetIssue to false if the photo doesn't show a public infrastructure problem (for example a selfie, a pet, food, a screenshot, or the inside of a home). Set privacyConcern to true if a person's face or a readable license plate is clearly visible.`,
            prompt: 'Fill in the report from this photo.',
            image: photo,
            schema: { type: 'object', properties: { isStreetIssue: { type: 'boolean' }, privacyConcern: { type: 'boolean' }, ...REPORT_FIELDS }, required: ['isStreetIssue', 'privacyConcern', 'category', 'title', 'description'] },
        });
        if (draft.isStreetIssue === false) return res.json({ isStreetIssue: false });
        res.json({ isStreetIssue: true, privacyConcern: Boolean(draft.privacyConcern), ...cleanReport(draft) });
    } catch (error) {
        aiFailure(res, 'Photo reading', error);
    }
});

const AUDIO_TYPES = /^(audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)|video\/(webm|mp4))(;.*)?$/i;
app.post('/api/cony/transcribe', aiBurst('cony-voice', 8), needAi, express.raw({ type: (req) => AUDIO_TYPES.test(req.headers['content-type'] || ''), limit: '6mb' }), aiDailyCap, async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: 'That recording was empty. Tap Say it and try again.' });
    try {
        const text = await ai.transcribe({ audio: req.body, mimeType: req.headers['content-type'].split(';')[0].toLowerCase() });
        if (!text) return res.status(422).json({ error: 'Cony couldn’t hear any words. Try again somewhere quieter.' });
        res.json({ text: text.slice(0, 2000) });
    } catch (error) {
        aiFailure(res, 'Voice transcription', error);
    }
});

app.post('/api/cony/tidy', aiBurst('cony-tidy', 10), needAi, aiDailyCap, async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || text.trim().length < 5 || text.length > 2000) return res.status(400).json({ error: 'Say or type a few words about the problem first.' });
    try {
        const draft = await ai.generateJson({
            system: `You are Cony, Sidewalk's helper. A resident described a problem in a public street, sidewalk, or park, maybe in a language other than English, maybe as a rambling voice note. Turn it into a clear report in English. ${REPORT_RULES} Set language to the English name of the language the resident used (for example "English", "Spanish", "Vietnamese").`,
            prompt: `Resident's words:\n${text.trim()}`,
            schema: { type: 'object', properties: { ...REPORT_FIELDS, language: { type: 'string' } }, required: ['category', 'title', 'description', 'language'] },
        });
        const report = cleanReport(draft);
        if (!report.title || !report.description) return res.status(502).json({ error: 'Cony couldn’t make sense of that. Try adding a little more detail.' });
        res.json({ ...report, language: String(draft.language || 'English').slice(0, 40) });
    } catch (error) {
        aiFailure(res, 'Report tidy-up', error);
    }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Any other unknown page gets the "road closed" page.
app.use((req, res) => {
    res.status(404);
    if (req.accepts('html')) return res.sendFile(path.join(__dirname, 'public', '404.html'));
    res.type('text').send('Not found');
});

app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: 'Request must contain valid JSON.' });
    console.error(`Unhandled error on ${req.method} ${req.path}:`, error);
    if (res.headersSent) return next(error);
    if (!req.path.startsWith('/api') && req.accepts('html')) return res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
    console.log(`Server is running! Open your browser and go to: http://localhost:${PORT}`);
});

// Hosts send SIGTERM when replacing the app with a new version. Finish in-flight requests,
// close the database cleanly, then exit, instead of being cut off mid-write.
let shuttingDown = false;
function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: finishing open requests and shutting down.`);
    server.close(() => {
        communityRoutes.close();
        console.log('Shut down cleanly.');
        process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => {
        communityRoutes.close();
        process.exit(0);
    }, 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
