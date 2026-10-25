const express = require('express');
const dotenv = require('dotenv');
const path = require('node:path');
dotenv.config();

const { createAi, describeAiError } = require('./ai');
const communityRoutes = require('./community');

const app = express();
// Behind a host like Render or Railway, trust its proxy so rate limits see real client IPs.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);
// Reports can carry up to four compressed photos as base64.
app.use(express.json({ limit: '14mb' }));

// Serves all files inside your public folder (index.html, style.css, app.js)
app.use(express.static('public'));
app.use('/vendor/leaflet-heat', express.static(path.join(__dirname, 'node_modules', 'leaflet.heat', 'dist')));
app.use('/api', communityRoutes);

// Keep AI keys on the server; never send them to the browser.
const ai = createAi();
app.locals.ai = ai;
console.log(ai ? `AI assistant: ${ai.provider} (${ai.model})` : 'AI assistant: off (set GROQ_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)');

app.post('/api/convert', async (req, res) => {
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
app.post('/api/chat', async (req, res) => {
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

    try {
        const reply = await ai.chat({
            system: 'You are Sidewalk Civic Assistant, a practical and respectful guide to local infrastructure reporting in North and South Carolina. Help residents describe issues clearly, understand common civic reporting steps, and draft concise messages. Do not claim to submit reports, contact officials, verify local laws, or know agency contacts unless the user provides that information. Ask a clarifying question when location or details matter. Be transparent when uncertain. Never state phone numbers, email addresses, or web addresses unless the user gave them; instead tell the user where to look, such as their city or county website or 311 line. Write in plain text for a small chat bubble: no Markdown, no headings, no tables, no bold or asterisks, and no emoji. Keep replies under 120 words; use short numbered steps (1. 2. 3.) only when giving steps.',
            history: priorMessages,
            message: message.trim(),
        });

        if (!reply) return res.status(502).json({ error: 'The assistant returned an empty response. Please try again.' });
        res.json({ reply });
    } catch (error) {
        console.error('AI assistant failed:', error.message);
        const friendly = describeAiError(error);
        if (friendly) return res.status(503).json({ error: friendly });
        res.status(502).json({ error: 'Could not get a reply from the AI service. Please try again shortly.' });
    }
});

app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error instanceof SyntaxError && error.status === 400 && 'body' in error) return res.status(400).json({ error: 'Request must contain valid JSON.' });
    next(error);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running! Open your browser and go to: http://localhost:${PORT}`);
});
