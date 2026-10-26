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
function createOpenAiCompatible({ provider, label, apiKey, baseUrl, model, visionModel, speechModel }) {
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

  const jsonInstructions = (system, schema) => `${system}\n\nRespond with only a JSON object that matches this JSON Schema exactly:\n${JSON.stringify({ ...schema, additionalProperties: false })}`;

  return {
    provider,
    label,
    model,
    // Reads one photo (a data: URL) and answers as JSON.
    async describeImage({ system, prompt, image, schema }) {
      const text = await call({
        model: visionModel,
        messages: [
          { role: 'system', content: jsonInstructions(system, schema) },
          { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] },
        ],
        response_format: { type: 'json_object' },
      });
      return JSON.parse(text || '{}');
    },
    // Speech to text. audio is a Buffer; returns the words spoken, in the language spoken.
    async transcribe({ audio, mimeType }) {
      const ext = /mp4|m4a|aac/.test(mimeType) ? 'm4a' : /ogg/.test(mimeType) ? 'ogg' : /wav/.test(mimeType) ? 'wav' : /mpeg|mp3/.test(mimeType) ? 'mp3' : 'webm';
      const form = new FormData();
      form.append('file', new Blob([audio], { type: mimeType }), `voice.${ext}`);
      form.append('model', speechModel);
      form.append('response_format', 'json');
      const response = await fetch(`${baseUrl}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw errorFrom(response.status, data);
      return (data.text || '').trim();
    },
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
    visionModel: process.env.OPENAI_VISION_MODEL || process.env.OPENAI_MODEL || 'gpt-5-mini',
    speechModel: process.env.OPENAI_SPEECH_MODEL || 'whisper-1',
  });
}

function createGroq() {
  return createOpenAiCompatible({
    provider: 'groq',
    label: 'Groq',
    apiKey: process.env.GROQ_API_KEY.trim(),
    baseUrl: 'https://api.groq.com/openai/v1',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    // Groq's free photo-reading and speech models (console.groq.com/docs/vision, /docs/speech-to-text).
    visionModel: process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b',
    speechModel: process.env.GROQ_SPEECH_MODEL || 'whisper-large-v3-turbo',
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
    async describeImage({ system, prompt, image, schema }) {
      const [, mimeType, data] = image.match(/^data:([^;]+);base64,(.+)$/) || [];
      try {
        const response = await client.models.generateContent({
          model,
          config: { systemInstruction: system, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data } }] }],
        });
        return JSON.parse(response.text || '{}');
      } catch (error) {
        if (error instanceof SyntaxError) throw error;
        throw geminiError(error);
      }
    },
    async transcribe({ audio, mimeType }) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: [{ role: 'user', parts: [{ text: 'Transcribe this voice note word for word, in the language spoken. Reply with only the transcript.' }, { inlineData: { mimeType: mimeType.split(';')[0], data: audio.toString('base64') } }] }],
        });
        return (response.text || '').trim();
      } catch (error) {
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
