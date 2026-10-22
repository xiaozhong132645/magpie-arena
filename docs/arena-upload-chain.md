# arena 参考图（图片编辑）链路

状态：**已实现并端到端跑通**（2026-10-22）。

从「本地任意图片」到「arena 拿它生成新图」的完整路径，以及沿途踩的坑。

---

## 1. Magpie 发给插件什么

`generate_image` 带 `reference_images` 时，Magpie 调：

```
POST /v1/images/edits
Content-Type: multipart/form-data

n=1
model=gpt-image-2.5-sunburst
prompt=make the cat orange
image=<binary>   filename="image0.webp", Content-Type: image/webp
```

实测 multipart 字段就是 `n` / `model` / `prompt` / `image`。

插件实现的是标准 OpenAI images/edits。

## 2. arena 侧的附件结构

`POST /nextjs-api/stream/create-evaluation` 的
`userMessage.experimental_attachments` 必须是：

```json
[{ "name": "x.webp", "contentType": "image/webp", "url": "<signed r2 url>" }]
```

**三个字段缺一不可**。只传 `{url}` 或 `{type,url}` 会得到
`400 {"error":"Model does not support file input"}`。

`url` 必须是 arena r2 上带 `X-Amz-Signature` 的地址；
`data:` URL 会得到 `400 {"error":"Invalid content"}`。

## 3. 上传链路（三个 Server Action 步骤）

arena 的消息附件存储不在普通 HTTP 路由上，而是 **React Server Actions**。
从 client bundle 里挖到的两个 action id：

| 步骤 | action id | 作用 |
|---|---|---|
| `generateUploadUrl(name, type)` | `704145b69989c6b49d880846a53651e6fbab687a67` | 返回 `{uploadUrl, key}`，uploadUrl 指向 `messages-prod.*.r2.cloudflarestorage.com` |
| `getSignedUrl(key)` | `605d54c9cd73310ba84031b0fdffb9cf60aadb05c0` | 返回 `{url}`，带 `X-Amz-Signature` 可读地址 |

中间一步是 `PUT uploadUrl` 直传字节。

### 调用 Server Action 的正确形状（关键坑）

```js
const fd = new FormData();
fd.append('0', JSON.stringify([name, type]));   // 整个参数数组放进字段 "0"
await fetch(location.href, { method: 'POST', headers: { 'Next-Action': actionId }, body: fd });
```

**只认这一种**。其它写法全部失败，且失败信息骗人：

| 写法 | 结果 |
|---|---|
| 字段 `0`=JSON 数组 ← **正确** | `{"success":true,"data":{...}}` |
| 一个参数一个字段（`1`=`name`, `2`=`type`） | `{"success":false,"error":"Failed to generate upload url"}` |
| body 直接是 JSON 数组 | 同上 |
| 对象形式参数 | 同上 |

那个 `Failed to generate upload url` 看起来像后端错误，其实是参数没传进去。
排查时不要被它误导。

### 响应是本 RSC flight data，不是 JSON

必须先正则截取：

```js
const m = text.match(/\{"success":[\s\S]*?\}\}/);
```

## 4. 实测通过的三段

```
本地 webp
  → generateUploadUrl  → key = <uid>/<ts>-<name>.webp
  → PUT 到 messages-prod (200)
  → getSignedUrl       → https://messages-prod.../...?X-Amz-Signature=...
  → experimental_attachments
  → 200，出 2 张图
```

视觉验证：红苹果 → 蓝苹果，果形/果核/高光/投影/白底全保持，只颜色变。
（`.samples/chain-red.webp` → `.samples/b-result.webp`）

## 5. 已验证可省的场景

**arena 自己生成的图片 URL 可以直接回传当下一轮输入**，不需要重新上传。

所以多轮迭代是零成本的：把上一次结果的 `url` 原样塞回 `reference_images`
（插件会识别 http(s) 前缀，跳过上传）。实测红→绿、红→蓝都成功。

## 6. 能力边界

40 个模型里 **26 个**支持图片输入：

- 多图输入：`gpt-image-2.5-sunburst`、`seedream-5.0-pro`、`gemini-2.5-flash-image-preview`、`gemini-3.1-flash-lite-image` 等
- 单图且 `requiresUpload: true`：`seededit-3.0`
- 纯文生图（不能改图，14 个）：`recraft-v4`、`photon`、`krea-2-*`、`seedream-3`、`hidream-o1-image`、`wan2.5-t2i-preview` 等

对不支持的模型，本插件不拦截，由 arena 回 400。

## 7. 实现位置

- `arena.mjs`
  - `uploadImage(buf, name, mimeType)` — 三段式上传，返回 `{url, key}`
  - `generate({ prompt, model, referenceImages })` — 字符串按 URL 直接用，`{buf,...}` 走上传
  - `_generateOnce({ ..., attachments })` — 塞进 `experimental_attachments`
- `index.mjs`
  - `POST /v1/images/edits` — 解析 multipart，收集 `image` 字段，调 `engine.generate`

## 8. 注意事项

- 两个 action id 是**编译进当前前端 bundle** 的。arena 重新部署可能改变它们，
  届时上传会报 `generateUploadUrl: ...`，需要重新从 chunk 里挖。
  查找方式：搜 client chunk 里的 `createServerReference(` 与 `generateUploadUrl` / `getSignedUrl`。
- 上传发生在**点发送时**，不是选文件时。只调 `DOM.setFileInputFiles` 不发请求。
- 前端用 hono/orpc 风格客户端，CDP 抓包只能看到被 Cloudflare RUM 包装的
  `/rpc/i/v0/e/`，看不到真实端点 —— 这段只能读 JS。
