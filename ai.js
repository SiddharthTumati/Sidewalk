// One AI interface for Sidewalk, backed by OpenAI (GPT) or Google Gemini.
// Picks OpenAI when OPENAI_API_KEY is set, otherwise Gemini when GEMINI_API_KEY is set.
// Set AI_PROVIDER=openai or AI_PROVIDER=gemini to choose explicitly.

class AiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'rate_limit' | 'quota' | 'other'
  }
}

function pickProvider() {
  const wanted = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (wanted === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : null;
  if (wanted === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

// ---------- OpenAI ----------
function createOpenAi() {
  const apiKey = process.env.OPENAI_API_KEY.trim();
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';

  async function call(body) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data.error?.message || `OpenAI request failed (${response.status})`;
      const code = data.error?.code || data.error?.type || '';
      const kind = response.status === 401 ? 'auth'
        : code === 'insufficient_quota' ? 'quota'
        : response.status === 429 ? 'rate_limit' : 'other';
      throw new AiError(`OpenAI ${response.status}: ${message}`, response.status, kind);
    }
    return data.choices?.[0]?.message?.content || '';
  }

  return {
    provider: 'openai',
    model,
    async generateJson({ system, prompt, schema }) {
      const text = await call({
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: { ...schema, additionalProperties: false } } },
      });
      return JSON.parse(text || '{}');
    },
    async chat({ system, history, message }) {
      return call({
        messages: [
          { role: 'system', content: system },
          ...history.map((entry) => ({ role: entry.role === 'model' ? 'assistant' : 'user', content: entry.text })),
          { role: 'user', content: message },
        ],
      });
    },
  };
}

// ---------- Gemini ----------
function toGeminiSchema(schema) {
  const out = { type: schema.type.toUpperCase() };
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]));
  }
  if (schema.required) out.required = schema.required;
  return out;
}

function geminiError(error) {
  const message = error.message || 'Gemini request failed';
  const kind = /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|ACCESS_TOKEN_TYPE_UNSUPPORTED/i.test(message) || error.status === 401 ? 'auth'
    : error.status === 429 ? 'rate_limit' : 'other';
  return new AiError(`Gemini: ${message}`, error.status, kind);
}

function createGemini() {
  const { GoogleGenAI } = require('@google/genai');
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY.trim() });
  const model = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
  return {
    provider: 'gemini',
    model,
    async generateJson({ system, prompt, schema }) {
      try {
        const response = await client.models.generateContent({
          model,
          config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
          contents: prompt,
        });
        return JSON.parse(response.text || '{}');
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        throw geminiError(error);
      }
    },
    async chat({ system, history, message }) {
      try {
        const response = await client.models.generateContent({
          model,
          config: { systemInstruction: system },
          contents: [
            ...history.map((entry) => ({ role: entry.role === 'model' ? 'model' : 'user', parts: [{ text: entry.text }] })),
            { role: 'user', parts: [{ text: message }] },
          ],
        });
        return response.text || '';
      } catch (error) {
        throw geminiError(error);
      }
    },
  };
}

function createAi() {
  const provider = pickProvider();
  if (provider === 'openai') return createOpenAi();
  if (provider === 'gemini') return createGemini();
  return null;
}

// A short, user-facing explanation for an AI failure.
function describeAiError(error) {
  const name = error.message?.startsWith('Gemini') ? 'Gemini' : 'OpenAI';
  if (error.kind === 'auth') return `${name} rejected the API key. Check the key in the server's environment variables, then restart.`;
  if (error.kind === 'quota') return 'The OpenAI account is out of credit. Add billing credit at platform.openai.com, then try again.';
  if (error.kind === 'rate_limit') return 'The AI service is temporarily rate-limited. Please try again in a moment.';
  return null;
}

module.exports = { createAi, describeAiError, AiError };
