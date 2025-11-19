// server.js - Clean + Patched NVIDIA NIM Proxy
const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------------------------------------------
   ✅ FIX 413 ERROR (Payload Too Large)
---------------------------------------------- */
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Middleware
app.use(cors());

// NVIDIA API config
const NIM_API_BASE =
  process.env.NIM_API_BASE || "https://integrate.api.nvidia.com/v1";
const NIM_API_KEY = process.env.NIM_API_KEY;

// Toggles
const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// 🔥 Unlimited token override
const MAX_TOKENS_OVERRIDE = 999999;

// 🔥 Model mapping
const MODEL_MAPPING = {
  "gpt-3.5-turbo": "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "gpt-4": "qwen/qwen3-coder-480b-a35b-instruct",
  "gpt-4-turbo": "moonshotai/kimi-k2-instruct-0905",
  "gpt-4o": "deepseek-ai/deepseek-v3.1", // your DeepSeek
  "claude-3-opus": "openai/gpt-oss-120b",
  "claude-3-sonnet": "openai/gpt-oss-20b",
  "gemini-pro": "qwen/qwen3-next-80b-a3b-thinking",
};

// Root endpoint
app.get("/", (req, res) => {
  res.send("🚀 NVIDIA NIM Proxy Server is Running!");
});

// Health endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "NIM Proxy",
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
  });
});

// List models
app.get("/v1/models", (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map((model) => ({
    id: model,
    object: "model",
    created: Date.now(),
    owned_by: "nvidia-nim-proxy",
  }));

  res.json({ object: "list", data: models });
});

// Chat completions (MAIN ENDPOINT)
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    /* -----------------------------
       MODEL RESOLUTION
    ------------------------------ */
    let nimModel = MODEL_MAPPING[model];

    // Auto-detect unknown model
    if (!nimModel) {
      try {
        const test = await axios.post(
          `${NIM_API_BASE}/chat/completions`,
          {
            model: model,
            messages: [{ role: "user", content: "test" }],
            max_tokens: 1,
          },
          {
            headers: {
              Authorization: `Bearer ${NIM_API_KEY}`,
              "Content-Type": "application/json",
            },
            validateStatus: (s) => s < 500,
          }
        );

        if (test.status >= 200 && test.status < 300) {
          nimModel = model; // model exists on NVIDIA
        }
      } catch (e) {}

      if (!nimModel) {
        const m = model.toLowerCase();
        if (m.includes("gpt-4") || m.includes("405b")) {
          nimModel = "meta/llama-3.1-405b-instruct";
        } else if (m.includes("claude") || m.includes("70b")) {
          nimModel = "meta/llama-3.1-70b-instruct";
        } else {
          nimModel = "meta/llama-3.1-8b-instruct";
        }
      }
    }

    /* -----------------------------
       BUILD REQUEST
    ------------------------------ */
    const nimRequest = {
      model: nimModel,
      messages,
      temperature: temperature ?? 0.6,
      max_tokens: MAX_TOKENS_OVERRIDE, // 🔥 forced unlimited tokens
      stream: stream || false,
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined,
    };

    /* -----------------------------
       SEND REQUEST TO NVIDIA
    ------------------------------ */
    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      nimRequest,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          "Content-Type": "application/json",
        },
        responseType: stream ? "stream" : "json",
      }
    );

    /* -----------------------------
       STREAMING RESPONSE MODE
    ------------------------------ */
    if (stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let buffer = "";
      let reasoningStarted = false;

      response.data.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        lines.forEach((line) => {
          if (!line.startsWith("data: ")) return;

          if (line.includes("[DONE]")) {
            res.write(line + "\n");
            return;
          }

          try {
            const data = JSON.parse(line.slice(6));

            if (data.choices?.[0]?.delta) {
              const delta = data.choices[0].delta;
              const reasoning = delta.reasoning_content;
              const content = delta.content;

              if (SHOW_REASONING) {
                let combined = "";

                if (reasoning && !reasoningStarted) {
                  combined = "<think>\n" + reasoning;
                  reasoningStarted = true;
                } else if (reasoning) {
                  combined = reasoning;
                }

                if (content && reasoningStarted) {
                  combined += "</think>\n\n" + content;
                  reasoningStarted = false;
                } else if (content) {
                  combined += content;
                }

                if (combined) delta.content = combined;
                delete delta.reasoning_content;
              } else {
                delta.content = content || "";
                delete delta.reasoning_content;
              }
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch {
            res.write(line + "\n");
          }
        });
      });

      response.data.on("end", () => res.end());
      response.data.on("error", () => res.end());

      return;
    }

    /* -----------------------------
       NON-STREAM MODE
    ------------------------------ */
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: response.data.choices.map((choice) => {
        let fullContent = choice.message?.content || "";

        if (SHOW_REASONING && choice.message?.reasoning_content) {
          fullContent =
            "<think>\n" +
            choice.message.reasoning_content +
            "\n</think>\n\n" +
            fullContent;
        }

        return {
          index: choice.index,
          message: { role: choice.message.role, content: fullContent },
          finish_reason: choice.finish_reason,
        };
      }),
      usage: response.data.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    res.json(openaiResponse);
  } catch (error) {
    console.error("Proxy error:", error.message);

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || "Internal server error",
        type: "invalid_request_error",
        code: error.response?.status || 500,
      },
    });
  }
});

// 404 handler
app.all("*", (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: "invalid_request_error",
      code: 404,
    },
  });
});

app.listen(PORT, () => {
  console.log(`🔥 NIM Proxy running on port ${PORT}`);
  console.log(`Health check → http://localhost:${PORT}/health`);
});
