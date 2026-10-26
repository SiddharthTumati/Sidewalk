// One AI interface for Sidewalk, backed by Groq (free), OpenAI (GPT), or Google Gemini.
// Picks the first one with a key set: GROQ_API_KEY, then OPENAI_API_KEY, then GEMINI_API_KEY.
// Set AI_PROVIDER=groq, openai, or gemini to choose explicitly.

class AiError extends Error {
  constructor(message, status, kind) {
    super(message);
    this.status = status;
    this.kind = kind; // 'auth' | 'rate_limit' | 'quota' | 'other'
  }
}

function pickProvider() {
  const wanted = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (wanted === 'groq') return process.env.GROQ_API_KEY ? 'groq' : null;
  if (wanted === 'openai') return process.env.OPENAI_API_KEY ? 'openai' : null;
  if (wanted === 'gemini') return process.env.GEMINI_API_KEY ? 'gemini' : null;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return null;
}

// ---------- OpenAI-compatible (OpenAI, Groq) ----------
function createOpenAiCompatible({ provider, label, apiKey, baseUrl, model }) {
  function post(body) {
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
  }

  function errorFrom(status, data) {
    const message = data.error?.message || `${label} request failed (${status})`;
    const code = data.error?.code || data.error?.type || '';
    const kind = status === 401 ? 'auth'
      : code === 'insufficient_quota' ? 'quota'
      : status === 429 ? 'rate_limit' : 'other';
    return new AiError(`${label} ${status}: ${message}`, status, kind);
  }

  async function call(body) {
    const response = await post(body);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw errorFrom(response.status, data);
    return data.choices?.[0]?.message?.content || '';
  }

  const chatMessages = ({ system, history, message }) => [
    { role: 'system', content: system },
    ...history.map((entry) => ({ role: entry.role === 'model' ? 'assistant' : 'user', content: entry.text })),
    { role: 'user', content: message },
  ];

  return {
    provider,
    label,
    model,
    async generateJson({ system, prompt, schema }) {
      const strictSchema = { ...schema, additionalProperties: false };
      try {
        const text = await call({
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
          response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: strictSchema } },
        });
        return JSON.parse(text || '{}');
      } catch (error) {
        // Some models (e.g. many on Groq) only support plain JSON mode; retry with the schema in the prompt.
        if (!(error instanceof AiError) || error.status !== 400) throw error;
        const text = await call({
          messages: [
            { role: 'system', content: `${system}\n\nRespond with only a JSON object that matches this JSON Schema exactly:\n${JSON.stringify(strictSchema)}` },
            { role: 'user', content: prompt },
          ],
          response_format: { type: 'json_object' },
        });
        return JSON.parse(text || '{}');
      }
    },
    async chat(input) {
      return call({ messages: chatMessages(input) });
    },
    // Yields the reply a few words at a time as the model writes it (server-sent events).
    async *chatStream(input) {
      const response = await post({ messages: chatMessages(input), stream: true });
      if (!response.ok) throw errorFrom(response.status, await response.json().catch(() => ({})));
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          let event;
          try { event = JSON.parse(payload); } catch { continue; }
          if (event.error) throw errorFrom(500, event);
          const text = event.choices?.[0]?.delta?.content;
          if (text) yield text;
        }
      }
    },
  };
}

function createOpenAi() {
  return createOpenAiCompatible({
    provider: 'openai',
    label: 'OpenAI',
    apiKey: process.env.OPENAI_API_KEY.trim(),
    baseUrl: 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
  });
}

function createGroq() {
  return createOpenAiCompatible({
    provider: 'groq',
    label: 'Groq',
    apiKey: process.env.GROQ_API_KEY.trim(),
    baseUrl: 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  });
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
    label: 'Gemini',
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
    async *chatStream({ system, history, message }) {
      let stream;
      try {
        stream = await client.models.generateContentStream({
          model,
          config: { systemInstruction: system },
          contents: [
            ...history.map((entry) => ({ role: entry.role === 'model' ? 'model' : 'user', parts: [{ text: entry.text }] })),
            { role: 'user', parts: [{ text: message }] },
          ],
        });
      } catch (error) {
        throw geminiError(error);
      }
      try {
        for await (const chunk of stream) if (chunk.text) yield chunk.text;
      } catch (error) {
        throw geminiError(error);
      }
    },
  };
}

function createAi() {
  const provider = pickProvider();
  if (provider === 'groq') return createGroq();
  if (provider === 'openai') return createOpenAi();
  if (provider === 'gemini') return createGemini();
  return null;
}

// A short, user-facing explanation for an AI failure.
function describeAiError(error) {
  const name = (error.message || '').split(' ')[0].replace(':', '') || 'The AI service';
  if (error.kind === 'auth') return `${name} rejected the API key. Check the key in the server's environment variables, then restart.`;
  if (error.kind === 'quota') return 'The OpenAI account is out of credit. Add billing credit at platform.openai.com, then try again.';
  if (error.kind === 'rate_limit') return 'The AI service is temporarily rate-limited. Please try again in a moment.';
  return null;
}

module.exports = { createAi, describeAiError, AiError };
