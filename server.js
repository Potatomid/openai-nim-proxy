// server.js - NVIDIA NIM Proxy optimized for Janitor AI

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

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const nimAxios = axios.create({
  timeout: 60000,
  httpAgent,
  httpsAgent,
  maxContentLength: 50 * 1024 * 1024,
  maxBodyLength: 50 * 1024 * 1024
});

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

const MIN_COMPLETION_TOKENS = 1;
const MAX_COMPLETION_TOKENS = 2048;

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

// ✅ Janitor AI compatibility: support BOTH routes
app.post(['/v1/chat/completions', '/chat/completions'], async (req, res) => {
  try {
    const { model, messages = [], temperature, max_tokens } = req.body;

    const nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-70b-instruct';

    // ✅ Only inject system prompt if Janitor didn't already provide one
    const hasSystem = messages.some(m => m.role === 'system');

    const enforcedMessages = hasSystem
      ? messages
      : [
          {
            role: "system",
            content: `
You are a creative narrator. Your responses must be immersive and richly descriptive:
- Include hair movement, gestures, posture, micro-expressions
- Show environmental interactions and sensory details
- Include internal thoughts subtly
- Describe moment-to-moment actions naturally
- Maintain clarity and readability
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
      stream: false
    };

    const response = await axiosWithRetry(() =>
      nimAxios.post(
        `${NIM_API_BASE}/chat/completions`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${NIM_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      )
    );

    const text =
      response.data?.choices?.[0]?.message?.content ||
      response.data?.output_text ||
      " ";

    // ✅ Strict OpenAI-compatible response
    res.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      system_fingerprint: "nim-proxy",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text
          },
          logprobs: null,
          finish_reason: "stop"
        }
      ],
      usage: response.data?.usage ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
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
});
