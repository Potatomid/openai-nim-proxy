// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE
const SHOW_REASONING = false;

// 🔥 THINKING MODE
const ENABLE_THINKING_MODE = false;

// 🔥🔥 UNLIMITED TOKEN CONSTANT
const MAX_TOKENS_OVERRIDE = 999999;

// Model mapping
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'qwen/qwen3-coder-480b-a35b-instruct',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',

  // ⭐ PATCH ADDED: DeepSeek official
  'gpt-4o': 'deepseek-ai/deepseek-v3.1',

  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking'
};

// -----------------------------------------------------
// Root endpoint
// -----------------------------------------------------
app.get('/', (req, res) => {
  res.send("🚀 NVIDIA NIM Proxy Server is Running!");
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI to NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));

  res.json({
    object: 'list',
    data: models
  });
});

// -----------------------------------------------------
// MAIN PROXY
// -----------------------------------------------------
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Always override max tokens
    const finalMaxTokens = MAX_TOKENS_OVERRIDE;

    // ------------------------------
    // ⭐ UNIVERSAL MODEL SUPPORT PATCH
    // ------------------------------
    let nimModel = MODEL_MAPPING[model];

    // If model not in mapping → allow direct model usage (DeepSeek etc.)
    if (!nimModel) {
      nimModel = model; // ⭐ PATCH ADDED
    }

    // ------------------------------
    // If someone sends "gpt-4o", use DeepSeek
    // ------------------------------
    if (model === "gpt-4o") {
      nimModel = "deepseek-ai/deepseek-v3.1"; // ⭐ PATCH ADDED
    }

    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature ?? 0.6,
      max_tokens: finalMaxTokens, // always override
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // Streaming
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.on('data', chunk => res.write(chunk.toString()));
      response.data.on('end', () => res.end());
      return;
    }

    // Normal response
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: response.data.choices.map(choice => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content
        },
        finish_reason: choice.finish_reason
      })),
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      }
    };

    res.json(openaiResponse);

  } catch (error) {
    console.error('Proxy error:', error.message);

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
