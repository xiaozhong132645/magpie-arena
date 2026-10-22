# magpie-arena

**arena.ai 的 40 个文生图模型，接进 Magpie。**

装上、登录一次你的 arena.ai 账号，`arena/gpt-image-2.5-sunburst`、`arena/seedream-5.0-pro`、
`arena/flux-3-image` 这些模型就和别的 provider 一样出现在 Magpie 里 —— AI agent 的
`generate_image` 工具可以直接用，网关的 `/v1/images/generations` 也可以直接调。

这是一个 [Magpie](https://usemagpie.ai) 的 **provider 插件**（Magpie 的 provider 插件与
OpenCode 插件同构），不是独立服务：不需要常驻进程，不需要额外端口。

> **English:** A Magpie / OpenCode provider plugin that exposes arena.ai's 40 text-to-image
> models so your agents can draw. It does not call an API — arena.ai binds its reCAPTCHA token
> to the browser fingerprint, so this drives a real Chrome and generates inside the page
> (see [Why it opens a browser](#为什么它要开一个浏览器)).

---

## 为什么它要开一个浏览器

arena.ai 用 reCAPTCHA v3 保护生图接口，而 **token 与浏览器指纹和 cookie jar 绑定**。
外部 HTTP 客户端（curl、requests、impit）即使拿到一个刚 mint 出来的有效 token 去 POST，
也会被拒：

```
403 {"error":"recaptcha validation failed"}
```

唯一能跑通的形态是「在同一个已登录页面上下文里取 token → 立刻 fetch」。所以这个插件不
模拟 API，它用 CDP 驱动一个 Chrome，在页面里完成整条链路：

```
你的 agent / Magpie 网关
        │  arena/<model>
        ▼
插件 fetch  ──►  CDP  ──►  Chrome（插件自己的 profile，无窗口）
                              │  页面内 mint grecaptcha token
                              │  POST /nextjs-api/stream/create-evaluation
                              ▼  SSE 返回图片地址 → 下载 → url / b64
```

那个浏览器由插件自己管理，profile 单独存放，不会碰你日常用的浏览器；关掉后下次请求
会自动重建。它跑在 **headless 模式，所以你的桌面上不会出现任何窗口**。

### 一个坑：headless 的 UA 必须改掉

headless Chrome 会在 User-Agent 里报 `HeadlessChrome/...`，reCAPTCHA Enterprise 把它判为
低信任客户端，于是 token 照常 mint 出来、POST 却永远 403。用 REA 抓真实点击的流量可以
直接看到这个差别：

```
user-agent: ... Chrome/155.0.0.0 Safari/537.36           → 通过
user-agent: ... HeadlessChrome/155.0.0.0 Safari/537.36   → 403 recaptcha validation failed
```

所以插件做了两件事：启动时传 `--user-agent=`，页面加载前再用
`Emulation.setUserAgentOverride` 覆盖 `navigator.userAgentData`（只改 UA 参数的话，
client hints 里仍会露出 headless 品牌）。

> 排查提示：如果哪天又出现 `403 recaptcha validation failed`，先怀疑 UA / client hints，
> 不要急着判定「账号被限流了」。这个误判我在开发时踩过 —— 两个不同 profile 都失败，
> 原因是它们都是 headless。想验证：`MAGPIE_ARENA_HEADLESS=0` 跑一次，能成就是 UA 问题。


---

### 会话保活

插件自己续期，不需要你每天重新粘贴 cookie。它做四件事：

- 每 3 分钟体检一次，剩余不足 12 分钟就续期
- 浏览器挂了就重建，而不是干等着
- 多个进程（网关 + 各 MCP server 共享一份 state）只有一个能续期，其余采纳它的结果
- 启动时如果 access token 已过期，先用 refresh_token 救一次，再判定未登录

**限制**：arena 的 refresh_token 一次性轮换，而且 Supabase 会检测复用并作废整个家族。
所以如果所有进程都关着超过一小时，会话就会失效，只能重新登录。

---

### 用参考图继续改

`generate_image` 的 `reference_images` 接文件路径或 http(s) URL：

```
generate_image(
  prompt: "把苹果从红色改成蓝色，构图不变",
  reference_images: ["assets/apple-red.png"],
)
```

两个关键点：

- **多轮迭代免费**：上一次结果图可以直接把它的 URL 塞回 `reference_images`，不用重新上传。
- **本地文件也行**：插件会先传到你自己账号的 arena 存储，再作为参考图。

40 个模型里 26 个支持图片输入，纯文生图的会回 400。

---

## 它不是什么

- **不是 API 逆向。** 它不伪造请求头、不破解 reCAPTCHA，就是用你自己的账号在浏览器里
  做你手动也能做的事。
- **不是 arena.ai 官方产品**，与 arena.ai 无关。用的是**你自己**的账号和额度。
- **参考图编辑支持 26/40 个模型。** `/v1/images/edits` 可用，本地图片会先上传到你自己
  账号的 arena 存储再作为参考图；纯文生图的模型（`recraft-v4`、`photon`、`seedream-3` 等
  14 个）不能改图，arena 会回 400。
- 在 Magpie 里它是 **provider 插件**，不是代理服务。

## 使用前请知悉

- 自动化访问可能不符合 arena.ai 的服务条款，**账号风险由你承担**。
- arena 对账号有生图速率限制。超了返回 `429 {"error":"prompt failed"}`（文案很坑，不是
  提示词问题）；密集请求后还会升级成 `403 recaptcha validation failed`，那是账号级风控
  评分下降，只能等它恢复。详见 [限流](#限流)。
- 登录凭证（cookie）等于账号权限。插件把它存在本机 `~/.magpie-arena/session.json`
  （权限 `0600` 尽力而为），**不要提交进 git，不要贴给别人**。

---

## 安装

```bash
magpie plugin add github:xiaozhong132645/magpie-arena
```

或本地克隆后：

```bash
git clone https://github.com/xiaozhong132645/magpie-arena.git
magpie plugin add ./magpie-arena
```

装完 `magpie plugin` 会看到：

```
github:xiaozhong132645/magpie-arena  on
  arena (Arena.ai, 40 models)  not signed in · magpie plugin login arena
```

## 登录

`magpie plugin login` 从 **stdin** 读凭证，不接受命令行参数。

**1. 取 cookie**：Chrome 打开 `https://arena.ai/image`（确认已登录）→ `F12` → Network →
刷新 → 点任意发往 `arena.ai` 的请求 → Request Headers 里 `cookie:` 的整行值复制。
只要包含完整的 `arena-auth-prod-v1`（分片 `.0` / `.1`）即可，缺了会报 `session_invalid`。

**2. 喂给 Magpie**：

```bash
# macOS / Linux
pbpaste | magpie plugin login arena

# Windows PowerShell
Get-Clipboard | magpie plugin login arena

# 或者从文件
magpie plugin login arena < cookie.txt
```

成功后会提示 `✓ signed in to Arena.ai · its models are arena/<model>`。

## 用

### 最重要的一件事：不要把 arena 模型选成 agent 的聊天模型

arena 的模型**只画图，不能聊天**。如果你在 Codex / Claude Code / OpenCode 的模型选择器里
把主模型选成了 `arena/...`，那个 agent 就废了 —— 它的每一句对话都会变成一次
`chat/completions`，而这个插件没有聊天能力：

```
Arena.ai: arena models draw images; they are not chat models.
This request came in as a chat completion, which usually means an agent
was switched to an arena model by mistake.
Fix: pick a text model for the agent, and let the agent draw by calling
Magpie's generate_image tool.
```

**正确姿势**是两步：

1. agent 的主模型是**文字模型**（DeepSeek / GLM / Claude …）
2. 让它画图时调 **`generate_image` 工具**（Magpie 的 image MCP），底层用哪个 arena 模型由
   `settings.json` 的 `imageGen` 决定

想从根上避免这种误选，让 arena 模型不进 agent 的模型列表：

```bash
magpie provider listed arena no      # arena 只通过路由组可用，不列进 agent 选择器
magpie provider listed arena yes     # 改回来
```

### 配好 generate_image 用哪个 arena 模型

编辑 `~/.config/magpie/settings.json`：

```json
{ "imageGen": "arena/gpt-image-2.5-sunburst" }
```

不设的话，Magpie 自动挑到的可能是别的 provider 的画图模型（比如 ChatGPT 那个，会 403）。

还要把这个 MCP 派给要用它的 agent（不派的话 agent 根本看不见 `generate_image`）：

```bash
magpie library mcp agents magpie-image codex     # 派给 codex（可逗号分隔多个）
magpie library sync
```

**网关直接调**（`model` 用 `arena/<名字>`）：

```bash
curl -X POST http://127.0.0.1:3425/v1/images/generations \
  -H "content-type: application/json" \
  -d '{"model":"arena/gpt-image-2.5-sunburst","prompt":"a red apple on a wooden table","response_format":"url"}'
```

`response_format`：`url`（默认，省流量）或 `b64_json`（直接给字节）。

**模型名从哪来**：

```bash
magpie provider arena          # 列出 arena 的模型与已暴露的子集
magpie models | grep arena     # 看 Magpie 给 agent 的列表
```

默认只暴露 40 个里的一部分。想换：

```bash
magpie provider models arena --all                 # 全部 40 个
magpie provider models arena +qwen-image-2.0       # 加一个
magpie provider models arena gpt-image-2.5-sunburst seedream-5.0-pro   # 只留这两个
```

---

## 保活（会话续期）

arena 的 access token 只有 1 小时有效期。插件三层保活，**不需要你手动维护**：

| 层 | 做什么 | 时机 |
|---|---|---|
| 主动续期 | 把 cookie 的 `expires_at` 改成过去 → 请求 `/api/me` → arena 的 Next.js 中间件发现会话过期，用 `refresh_token` 换新会话并下发新 cookie | 每次生图前检查，剩余 < 15 分钟就续期；另有 10 分钟定时器 |
| cookie 落盘 | 续期后把浏览器最新 cookie 写进 `~/.magpie-arena/session.json`；下次注入时取「更晚过期」的那份 | 续期后 / 登录后 |
| 浏览器重建 | `Browser.getVersion` 4 秒探活；Chrome 被关掉就重新拉起并沿用 profile 里的登录态 | 每次请求前 |

续期失败会**回滚**：先快照当前 cookie 分片，续期后仍未登录就把旧分片写回复验，
避免一次服务端抖动把可用会话搞丢。

**保活救不了的情况**：arena 主动让 refresh_token 失效（登出、改密码、长期不用、账号被清）。
这时接口会返回 `401 session_required` / `session_invalid`，重新跑一次
`magpie plugin login arena` 即可。

---

## 限流

arena 对账号有生图速率限制。超了它回的是 `429 {"error":"prompt failed"}` —— 文案很坑，
看起来像提示词问题，实际是限流。插件已经识别并翻译成：

```json
{"error":{"message":"arena.ai rate limited this account (429 \"prompt failed\"): too many image generations, try again later",
          "type":"arena_error","code":"arena_rate_limited"}}
```

带 `retry-after: 120`。等几分钟再试，不需要改提示词。

### 再往上就是 reCAPTCHA 风控

短时间内打太多之后，arena 会从 429 升级成：

```json
{"error":"recaptcha validation failed"}   // 403
```

这**不是** cookie 失效、也不是插件坏了。已验证的判断依据：

- `/api/me` 仍然是 200，登录态正常
- 页面里 `grecaptcha.enterprise.execute()` 仍能 mint 出 token
- 换一个全新的 Chrome profile、或换回有长期浏览历史的旧 profile，一样 403
- 成功出图与失败的那些请求，形状完全一致

结论：这是**账号 / IP 级别的 reCAPTCHA 评分被打下去**，只能等它自己恢复，越试越久。
观测顺序是 `429 prompt failed` → 若干分钟后 `403 recaptcha validation failed`，
恢复时间不确定（实测 25 分钟未恢复），建议停手数小时。

三种状态速查：

```bash
curl -s http://127.0.0.1:3425/v1/images/generations \
  -H "content-type: application/json" \
  -d '{"model":"arena/gpt-image-2.5-sunburst","prompt":"a lighthouse at dusk"}'
# 200                              -> 正常
# 429 arena_rate_limited           -> 限流，等几分钟
# 403 recaptcha validation failed  -> 风控，停手几小时
```

---

## 文件与状态

| 文件 | 作用 |
|---|---|
| `index.mjs` | 插件入口：`config` / `auth`（cookie）/ `provider.models` / `fetch` 实现 |
| `arena.mjs` | 引擎：Chrome + CDP、mint token、调 create-evaluation、解析 SSE、模型目录、续期 |
| `package.json` | 元数据 + `magpie.icon` |

运行时状态在 `~/.magpie-arena/`：

- `chrome-profile/` — 插件专用 Chrome profile（**不要指向你日常用的 profile**）
- `session.json` — 最近一次续期后的 cookie（**密钥，勿外传**）

## 排障

```bash
magpie plugin                          # 是否 on、是否 signed in、模型数
magpie models | grep arena             # 模型是否进了 Magpie 列表
magpie plugin rm arena                 # 卸载
```

| 现象 | 原因 |
|---|---|
| 模型数只有 1 个 | 没登录，或 arena 拉模型失败。先 `magpie plugin login arena` |
| `session_invalid` | cookie 里没有完整的 `arena-auth-prod-v1`，只复制了截断的一段 |
| `images_endpoint_required` | **agent 被选成了 arena 模型**。把 agent 主模型换回文字模型，改用 `generate_image` 工具，见 [上面](#最重要的一件事不要把-arena-模型选成-agent-的聊天模型) |
| `prompt is too long: about N tokens, more than ... context window` | 同一个原因：用生图模型跑了一阵对话，上下文撑爆了。换回文字模型 |
| `Model does not support file input` | 参考图给了不支持图片输入的模型。换 `gpt-image-2.5-sunburst` / `seedream-5.0-pro` / `gemini-*-image` 等 26 个支持的 |
| `arena_upload_failed: generateUploadUrl` | arena 前端重新部署，Server Action id 变了。见 [docs/arena-upload-chain.md](docs/arena-upload-chain.md) |
| `429 prompt failed` | 限流，见上 |
| `403 recaptcha validation failed` | 风控，见上 |
| agent 里没有 `generate_image` 工具 | `magpie library mcp agents magpie-image <agent>` 再 `magpie library sync` |
| Chrome 起不来 | 确认 `CHROME_CANDIDATES`（`arena.mjs` 顶部）里有你的 Chrome 路径 |

**Chrome 路径**默认按顺序探测 Windows / macOS / Linux 的常见位置。如果都不中，
改 `arena.mjs` 顶部的 `CHROME_CANDIDATES`，或把 `chrome` 放进 `PATH`。

**CDP 端口**默认 `9793`，被占用时设环境变量 `MAGPIE_ARENA_CDP_PORT`。

**无窗口运行**默认开启（`--headless=new`）。想看到浏览器在做什么，设
`MAGPIE_ARENA_HEADLESS=0`；它也是判断“是不是 UA 问题”的最快办法。

**改了代码却像是没生效**：Magpie 会把插件模块缓存在进程里，`magpie plugin on|off` 换不掉。
要真正重载，得卸载再装：

```bash
magpie plugin rm arena && magpie plugin add github:xiaozhong132645/magpie-arena
```


---

## License

Apache License 2.0。本项目与 arena.ai 无关，使用者自行承担账号合规与风险。
