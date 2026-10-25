const express = require('express');
const dotenv = require('dotenv');
const path = require('node:path');
dotenv.config();

const { GoogleGenAI, Type } = require('@google/genai');
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

// Keep the Gemini key on the server; never send it to the browser.
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
app.locals.gemini = ai;

app.post('/api/convert', async (req, res) => {
    const { message, location = '' } = req.body || {};
    if (typeof message !== 'string' || message.trim().length < 10 || message.length > 2000) {
        return res.status(400).json({ error: 'Describe the issue in 10 to 2,000 characters.' });
    }
    if (typeof location !== 'string' || location.length > 160) {
        return res.status(400).json({ error: 'Location must be 160 characters or fewer.' });
    }
    if (!ai) return res.status(503).json({ error: 'The AI converter is not configured. Add GEMINI_API_KEY to the server environment.' });

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            config: {
                systemInstruction: 'You help residents turn informal infrastructure complaints into clear, respectful public works requests. Preserve the user’s facts. Never invent addresses, laws, code violations, agency names, or injuries. Do not claim the request was submitted or legally verified. Assign urgency based only on described risk: Routine, Elevated, or Urgent. For immediate danger, say to contact emergency services separately.',
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING },
                        category: { type: Type.STRING, enum: ['Street safety', 'Accessibility', 'Parks & public space', 'Street lighting', 'Other'] },
                        urgency: { type: Type.STRING, enum: ['Routine', 'Elevated', 'Urgent'] },
                        summary: { type: Type.STRING },
                        emailSubject: { type: Type.STRING },
                        emailBody: { type: Type.STRING },
                    },
                    required: ['title', 'category', 'urgency', 'summary', 'emailSubject', 'emailBody'],
                },
            },
            contents: `Location provided by user: ${location.trim() || 'Not provided'}\n\nResident's description:\n${message.trim()}`,
        });
        const draft = JSON.parse(response.text || '{}');
        if (!draft.title || !draft.emailBody) return res.status(502).json({ error: 'The AI returned an incomplete draft. Please try again.' });
        res.json({ draft });
    } catch (error) {
        console.error('Civic converter failed:', error.message);
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
        return res.status(503).json({ error: 'The AI assistant is not configured. Add GEMINI_API_KEY to the server environment.' });
    }

    const priorMessages = Array.isArray(history)
        ? history
            .filter((entry) => entry && ['user', 'model'].includes(entry.role) && typeof entry.text === 'string')
            .slice(-12)
            .map((entry) => ({ role: entry.role, parts: [{ text: entry.text.slice(0, 2000) }] }))
        : [];

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3.8-flash',
            config: {
                systemInstruction: 'You are Sidewalk Civic Assistant, a practical and respectful guide to local infrastructure reporting in North and South Carolina. Help residents describe issues clearly, understand common civic reporting steps, and draft concise messages. Do not claim to submit reports, contact officials, verify local laws, or know agency contacts unless the user provides that information. Ask a clarifying question when location or details matter. Be transparent when uncertain.',
            },
            contents: [
                ...priorMessages,
                { role: 'user', parts: [{ text: message.trim() }] },
            ],
        });

        if (!response.text) return res.status(502).json({ error: 'The assistant returned an empty response. Please try again.' });
        res.json({ reply: response.text });
    } catch (error) {
        console.error('Error communicating with Gemini:', error.message);
        if (error.status === 400 && /API_KEY_INVALID|API key not valid/i.test(error.message || '')) {
            return res.status(503).json({ error: 'Gemini rejected the API key. Add a valid GEMINI_API_KEY to .env, then restart the server.' });
        }
        if (error.status === 401 || /ACCESS_TOKEN_TYPE_UNSUPPORTED|UNAUTHENTICATED/.test(error.message || '')) {
            return res.status(503).json({ error: 'Gemini rejected this credential type. Use a Gemini API key from Google AI Studio, not an OAuth/access token, then restart the server.' });
        }
        if (error.status === 429) {
            return res.status(503).json({ error: 'The AI service is temporarily rate-limited. Please try again in a moment.' });
        }
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
