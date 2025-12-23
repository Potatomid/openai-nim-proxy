// server.js - OpenAI to NVIDIA NIM API Proxy (STABLE VERSION)

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================
   NETWORK STABILITY FIXES
========================= */

// Keep-alive agents (prevents Failed to fetch)
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

// Axios instance with timeout + keepalive
const nimAxios = axios.create({
  timeout: 120000, // ⏱️ 120 seconds
  httpAgent,
  httpsAgent,
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024
});

// Simple retry wrapper
async function axiosWithRetry(fn, retries = 2) {
  try {
    return await fn();
  } catch (err) {
    if (retries <= 0) throw err;
    console.warn(`🔁 Retry due to error: ${err.message}`);
    await new Promise(r => setTimeout(r, 1500));
    return axiosWithRetry(fn, retries - 1);
  }
}

/* =========================
   MIDDLEWARE
========================= */

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/* =========================
   NVIDIA NIM CONFIG
========================= */

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

const MIN_COMPLETION_TOKENS = 500;
const MAX_COMPLETION_TOKENS = 1000;

/* =========================
   MODEL MAP
========================= */

const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

/* =========================
   ROUTES
========================= */

app.get('/', (req, res) => {
  res.send("🚀 NVIDIA NIM Proxy Server is Running!");
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    min_tokens: MIN_COMPLETION_TOKENS,
    max_tokens: MAX_COMPLETION_TOKENS
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Date.now(),
      owned_by: 'nvidia-nim-proxy'
    }))
  });
});

/* =========================
   CHAT COMPLETIONS
========================= */

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-70b-instruct';

    const enforcedMessages = [
      {
        role: "system",
        content: `
RESPONSE REQUIREMENTS (MANDATORY):
- MINIMUM ${MIN_COMPLETION_TOKENS} TOKENS
- DO NOT END EARLY
- CONTINUE NATURALLY IF FINISHED
- EXPAND IMMERSIVELY
`
      },
      ...messages
    ];

    const enforcedMaxTokens = Math.min(
      Math.max(max_tokens || MIN_COMPLETION_TOKENS, MIN_COMPLETION_TOKENS),
      MAX_COMPLETION_TOKENS
    );

    const payload = {
      model: nimModel,
      messages: enforcedMessages,
      temperature: temperature ?? 1,
      max_tokens: enforcedMaxTokens,
      stream: !!stream,
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined
    };

    const response = await axiosWithRetry(() =>
      nimAxios.post(
        `${NIM_API_BASE}/chat/completions`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${NIM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: stream ? 'stream' : 'json'
        }
      )
    );

    if (!response || !response.data) {
      throw new Error('NIM returned no data');
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      response.data.pipe(res);
      return;
    }

    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: response.data.choices,
      usage: response.data.usage
    });

  } catch (error) {
    console.error('❌ PROXY FAILURE:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data || error.message,
        type: 'proxy_error',
        code: error.response?.status || 500
      }
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`🔒 Tokens: ${MIN_COMPLETION_TOKENS} → ${MAX_COMPLETION_TOKENS}`);
});
