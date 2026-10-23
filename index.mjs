// Magpie provider plugin for arena.ai text-to-image models.
//
// Install:  magpie plugin add <path to this folder>
// Sign in:  magpie plugin login arena      (paste a arena.ai cookie)
//
// Magpie hands this plugin the request instead of dialing the network, so the
// plugin can do the browser dance arena.ai insists on (see arena.mjs) and answer
// /v1/images/generations itself. ASCII only.

import { ArenaEngine, parseCookieString, joinAuthCookie, decodeSession, guessMime } from "./arena.mjs";

const ID = "arena";
const VIRTUAL_API = "https://arena.invalid/v1";

class PluginError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    if (status === 401) this.signIn = "expired";
  }
}

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorBody(error) {
  const status = Number(error?.status) || 502;
  return [status, {
    error: {
      message: error?.message || "arena request failed",
      type: "arena_error",
      code: error?.code || "arena_error",
    },
  }];
}

/** validate the pasted cookie and return it as a single header string */
function cookieFromAuth(auth) {
  if (auth?.type !== "api" || typeof auth.key !== "string") {
    throw new PluginError(401, "session_required", "Paste an arena.ai cookie first (magpie plugin login arena).");
  }
  const raw = auth.key.trim().replace(/^cookie:\s*/i, "").replace(/\r?\n/g, " ");
  const map = parseCookieString(raw);
  const session = decodeSession(joinAuthCookie(map));
  if (!session) {
    throw new PluginError(401, "session_invalid", "That cookie has no complete arena-auth-prod-v1 session; copy the whole Cookie header from arena.ai.");
  }
  return raw;
}

function modelEntry(model, kind = "image") {
  const isChat = kind === "chat";
  return {
    id: model.name,
    providerID: ID,
    name: model.displayName || model.name,
    api: { id: model.name, url: VIRTUAL_API, npm: "@ai-sdk/openai-compatible" },
    status: "active",
    options: {},
    headers: {},
    // An image model has no conversation window. Left small, Magpie rejects a
    // long chat request locally with a confusing "prompt is too long" before it
    // ever reaches us, hiding the real problem (an agent was pointed at an image
    // model). Keeping it generous lets our explanatory error through instead.
    limit: { context: 1000000, output: 8192 },
    capabilities: {
      temperature: isChat,
      reasoning: false,
      attachment: false,
      toolcall: false,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: isChat, image: !isChat, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    variants: {},
  };
}

export const ArenaPlugin = async (_input, options = {}) => {
  const engine = new ArenaEngine({
    cookie: "",
    log: options.log ?? (() => {}),
    cdpPort: options.cdpPort,
    keepAliveMinutes: options.keepAliveMinutes,
  });
  let engineAuth = "";

  /** the engine holds one Chrome; a new cookie means a new sign-in */
  function engineFor(cookie) {
    if (cookie !== engineAuth) {
      engine.cookie = cookie;
      engineAuth = cookie;
      engine.ready = false;
      engine.models = null;
    }
    return engine;
  }

  /** download an arena image and return it as base64 */
  async function toB64(url) {
    const r = await fetch(url);
    if (!r.ok) throw new PluginError(502, "image_download_failed", "Could not download the generated image from arena.");
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.toString("base64");
  }

  return {
    async config(config) {
      config.provider ??= {};
      config.provider[ID] ??= {
        name: "Arena.ai",
        npm: "@ai-sdk/openai-compatible",
        api: VIRTUAL_API,
        // a placeholder so the provider shows up before the first catalog fetch
        models: {
          "gpt-image-2.5-sunburst": {
            name: "GPT Image 2.5 Sunburst",
            tool_call: false,
            attachment: false,
            modalities: { input: ["text"], output: ["image"] },
          },
        },
      };
    },

    auth: {
      provider: ID,
      maxConcurrency: 1,
      methods: [
        {
          type: "api",
          label: "Paste arena.ai cookie",
          placeholder: "cookie: _ga=...; arena-auth-prod-v1.0=...",
        },
      ],

      async loader(getAuth) {
        return {
          baseURL: VIRTUAL_API,
          apiKey: "arena-local",

          async fetch(input, init = {}) {
            let request;
            try {
              request = new Request(input, init);
            } catch (e) {
              return json(400, { error: { message: String(e), type: "invalid_request_error" } });
            }
            const url = new URL(request.url);

            const path = url.pathname;

            try {
              const cookie = cookieFromAuth(await getAuth());
              const engine = engineFor(cookie);

              // ---- anything but a chat misuse: make sure the session is alive first ----
              if (request.method === "POST") {
                try {
                  await engine.ensure();
                } catch (startError) {
                  // a stale profile can sit on an expired cookie; one forced renew
                  // (then a rebuild) before giving up
                  let recovered = false;
                  try {
                    recovered = await engine.renew();
                  } catch { /* fall through to a rebuild */ }
                  if (!recovered) {
                    engine._reset();
                    try {
                      await engine.ensure();
                      recovered = true;
                    } catch { /* report the original reason below */ }
                  }
                  if (!recovered) throw startError;
                }
              }

              // ---- image generation ----
              if (request.method === "POST" && (path === "/v1/images/generations" || path === "/images/generations")) {
                let body;
                try { body = await request.json(); } catch { throw new PluginError(400, "invalid_json", "Expected a JSON body."); }
                const prompt = body?.prompt;
                if (!prompt || typeof prompt !== "string") throw new PluginError(400, "prompt_required", "prompt is required");
                const model = typeof body?.model === "string" ? body.model : undefined;
                const n = Math.max(1, Math.min(Number(body?.n) || 1, 2));
                const wantB64 = body?.response_format === "b64_json";

                const results = [];
                for (let i = 0; i < n; i++) {
                  results.push(await engine.generate({ prompt, model }));
                  if (i < n - 1) await new Promise((r) => setTimeout(r, 1500));
                }
                const images = results.flatMap((r) => r.images);
                const data = [];
                for (const img of images) {
                  if (wantB64) data.push({ b64_json: await toB64(img.url) });
                  else data.push({ url: img.url });
                }
                return json(200, { created: Math.floor(Date.now() / 1000), data });
              }

              // ---- image edits: reference images become message attachments ----
              if (request.method === "POST" && (path === "/v1/images/edits" || path === "/images/edits")) {
                let form;
                try {
                  form = await request.formData();
                } catch {
                  throw new PluginError(
                    400,
                    "invalid_form",
                    "Expected multipart/form-data with prompt and one or more image files.",
                  );
                }

                const prompt = form.get("prompt");
                if (!prompt || typeof prompt !== "string") {
                  throw new PluginError(400, "prompt_required", "prompt is required");
                }
                const model = typeof form.get("model") === "string" ? form.get("model") : undefined;
                const wantB64 = form.get("response_format") === "b64_json";

                const files = [];
                for (const [field, value] of form.entries()) {
                  if (!value || typeof value === "string") continue;
                  if (!/^image$|^image\[|^image_/i.test(field) && !/^image0?$/i.test(field)) continue;
                  const blob = value;
                  if (typeof blob.arrayBuffer !== "function") continue;
                  const buf = Buffer.from(await blob.arrayBuffer());
                  if (!buf.length) continue;
                  files.push({
                    buf,
                    name: blob.name || `${field}.webp`,
                    mimeType: blob.type || guessMime(blob.name || field),
                  });
                }

                // tolerate the plain "image" field name used by OpenAI clients
                if (!files.length) {
                  for (const value of form.getAll("image")) {
                    if (!value || typeof value === "string") continue;
                    if (typeof value.arrayBuffer !== "function") continue;
                    const buf = Buffer.from(await value.arrayBuffer());
                    if (!buf.length) continue;
                    files.push({ buf, name: value.name || "image.webp", mimeType: value.type || "image/webp" });
                    break;
                  }
                }

                if (!files.length) {
                  throw new PluginError(
                    400,
                    "image_required",
                    "No image found in the request. Send one or more files under the \"image\" or \"image[]\" fields.",
                  );
                }

                const result = await engine.generate({
                  prompt,
                  model,
                  referenceImages: files,
                });
                const data = [];
                for (const img of result.images) {
                  if (wantB64) data.push({ b64_json: await toB64(img.url) });
                  else data.push({ url: img.url });
                }
                return json(200, { created: Math.floor(Date.now() / 1000), data });
              }

              // ---- chat completions: arena text arena ----
              if (request.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
                let body;
                try { body = await request.json(); } catch { throw new PluginError(400, "invalid_json", "Expected a JSON body."); }
                const messages = body?.messages;
                if (!Array.isArray(messages) || !messages.length) {
                  throw new PluginError(400, "messages_required", "messages is required");
                }
                const model = typeof body?.model === "string" ? body.model : undefined;
                const stream = body?.stream === true;

                // Reject only when the model is known to be an image model. A model
                // missing from the chat arena is not proof of anything: arena adds
                // and renames models constantly, and a stale catalog would otherwise
                // turn a working chat model into a confusing "this draws images".
                const wants = String(model || "").replace(/^arena\//, "").toLowerCase();
                let isImageOnly = false;
                if (wants) {
                  try {
                    const imgs = await engine.listArenaModels("text-to-image");
                    isImageOnly = imgs.some((m) => (m.name || "").toLowerCase() === wants);
                  } catch { /* cannot tell: let arena decide */ }
                }
                if (isImageOnly) {
                  throw new PluginError(
                    400,
                    "images_endpoint_required",
                    `${model} draws images; it is not a chat model. Pick a text model for the agent ` +
                    "(magpie <agent> <provider>/<chat-model>), and let the agent draw by calling Magpie's " +
                    "generate_image tool; set settings.json \"imageGen\" to choose which arena model that tool uses.",
                  );
                }

                const result = await engine.chat({ messages, model });

                if (!stream) {
                  return json(200, {
                    id: "chatcmpl-" + Date.now().toString(36),
                    object: "chat.completion",
                    created: Math.floor(Date.now() / 1000),
                    model: result.model,
                    choices: [{
                      index: 0,
                      message: { role: "assistant", content: result.text },
                      finish_reason: result.finishReason === "stop" ? "stop" : "stop",
                    }],
                  });
                }

                // SSE in the OpenAI shape
                const enc = new TextEncoder();
                const mk = (obj) => enc.encode("data: " + JSON.stringify(obj) + "\n\n");
                const idStr = "chatcmpl-" + Date.now().toString(36);
                const created = Math.floor(Date.now() / 1000);
                const streamBody = new ReadableStream({
                  start(controller) {
                    controller.enqueue(mk({
                      id: idStr, object: "chat.completion.chunk", created, model: result.model,
                      choices: [{ index: 0, delta: { role: "assistant", content: result.text }, finish_reason: null }],
                    }));
                    controller.enqueue(mk({
                      id: idStr, object: "chat.completion.chunk", created, model: result.model,
                      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                    }));
                    controller.enqueue(enc.encode("data: [DONE]\n\n"));
                    controller.close();
                  },
                });
                return new Response(streamBody, {
                  headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
                });
              }

              throw new PluginError(404, "unsupported_request", "arena plugin does not serve " + path);
            } catch (error) {
              const [status, body] = errorBody(error);
              return json(status, body, status === 429 ? { "retry-after": "120" } : {});
            }
          },
        };
      },
    },

    provider: {
      id: ID,
      async models(_provider, ctx) {
        const out = {};
        try {
          const cookie = cookieFromAuth(ctx?.auth);
          const engine = engineFor(cookie);

          // image arena: gated behind sign-in, and a 429/offline catalog must not
          // hide the chat models, so each arena is loaded independently
          try {
            const imgs = await engine.listArenaModels("text-to-image");
            for (const m of imgs) out[m.name] = modelEntry(m, "image");
          } catch { /* keep going: chat models may still load */ }

          try {
            const chats = await engine.listArenaModels("text");
            for (const m of chats) {
              // an image model name would shadow a same-named chat model, so only
              // fill names the image arena did not already claim
              if (!out[m.name]) out[m.name] = modelEntry(m, "chat");
            }
          } catch { /* image-only is still a working provider */ }

          if (Object.keys(out).length) return out;
        } catch {
          // no sign-in yet (or arena unreachable): fall through to placeholders
        }
        // keep the provider visible before the first sign-in so the prompt makes sense
        return {
          "gpt-image-2.5-sunburst": modelEntry({ name: "gpt-image-2.5-sunburst", displayName: "GPT Image 2.5 Sunburst" }, "image"),
        };
      },
    },
  };
};

export default ArenaPlugin;
