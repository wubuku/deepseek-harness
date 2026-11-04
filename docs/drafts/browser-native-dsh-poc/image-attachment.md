---
description: "Browser-Native PoC 的图片附件链路验证：composer 上传、Worker 附件服务与 LLM adapter 的 image_url 编码、backend 的 OpenAI/Anthropic 翻译、真实视觉端点回答，以及 OPFS 清空后的历史图片重建。"
---

# 多模态图片附件：上传、模型输入与历史渲染

本验证补齐浏览器端图片附件链路：composer 读取图片编码 → Worker `AttachmentStore` 校验与落盘 → Session 持久化 `ImageBlock` → Worker LLM adapter 读取字节并发出 `image_url` → backend 直通 OpenAI 或翻译 Anthropic image block → 模型回答 → 历史渲染重新读取同一引用。

## 链路与实现

composer 在提交时把图片编码成 base64 `SubmitAttachment {type:'image'}`。Worker 的 admission 把每个图片交给 `validateImage` 与 `saveImage`：校验媒体类型、字节、尺寸与像素上限，写入 OPFS，按 `sha256` 上传到同源 backend 附件对象，并挂载成 VFS 文件。Session 只保存 `ImageBlock {attachment}`；图片对象不进入 Workspace manifest，也不增加 Workspace revision。

Worker 的 LLM adapter 在每次请求前用 Session 中的 `ImageAttachmentRef` 调 `readImage`：从 OPFS 或 backend 补水、校验哈希与头信息，再拼成 `[{type:'text'}, {type:'image_url', image_url:{url:'data:<mediaType>;base64,...'}}]`。backend 对 OpenAI-compatible 端点原样转发；对 Anthropic 端点把同一 part 翻译为 `{type:'image', source:{type:'base64', media_type, data}}`，非 data URL 以 `INVALID_REQUEST` 拒绝且不触达上游。

历史渲染走 `uiConversation.imageUrl` → Session Controller `readAttachment` → `attachments.readImage`。因此刷新页面或清空 OPFS 后，图片仍能从 backend 对象重建，而不是依赖 composer 的本地 blob。

## 限制

图片上限为单张 20 MiB、单条消息 20 张与 200 MiB、64,000,000 像素、单边 8192 px，媒体类型为 PNG、JPEG、WebP、GIF。PoC 不做降采样、方向纠正或 EXIF 清理：provider 请求按原字节发送，失败由 provider 侧限制或报错决定。`readImageRequest`（按目标尺寸投影）沿用 `AttachmentStore` 的默认拒绝，任何依赖缩放的 provider 路径会得到 `ATTACHMENT_PROJECTION_UNSUPPORTED`。GIF 只按容器头读取首帧尺寸。附件对象按哈希存储，没有远端 GC；删除 Session 不会回收对象。

## 实测

`tests/image-attachment.e2e.mjs` 用真实 composer 的隐藏文件输入上传一张 64×64 红色 PNG（1108 bytes，`sha256:ae3d34b5…`）；页面内 canvas 生成图片，因此字节与渲染都可校验。

Chrome 156 scripted 运行：upload receipt 为 `{attachmentId: sha256:ae3d34b5…, name: ae3d34b5c7347b5a.png, bytes: 1108}`；Session 持久化 1 条 `ImageBlock`（mediaType `image/png`、64×64）；LLM 请求中的 `image_url` base64 解码后哈希与上传一致；assistant 文本为 `BROWSER_NATIVE_IMAGE_APPLICATION_APPLIED:image/png:1108:ae3d34b5c7347b5a`；转录渲染 `blob:` 图片，解码后 64×64 且哈希一致。随后清空 OPFS、刷新页面并续发一轮，同一 Session 触发 1 次附件 GET 补水，历史图片仍以相同字节渲染，图片事件仍只有 1 条。页面错误 0，跨源请求 0。

真实端点：使用 `.env` 的 `OPENAI_*` OpenAI-compatible 端点（`llmProviderKind: 'openai'`）跑同一脚本，模型对同一红色 PNG 回答 `Red`，说明 provider 实际读到了图像字节；该轮 assistant 文本不再是 scripted 标记。Anthropic 兼容端点在本轮未做真实调用，其 image block 翻译由 `tests/backend-v2.test.mjs` 的合同测试覆盖：断言上游收到 `{type:'image', source:{type:'base64', media_type:'image/png', data}}`，且非 data URL 返回 400 `INVALID_REQUEST`、上游请求数保持 1。

复跑：

```sh
pnpm --filter @deepseek-ai/dsh-web-frontend run build:preview
DSH_POC_BROWSER=chrome node docs/drafts/browser-native-dsh-poc/tests/image-attachment.e2e.mjs
DSH_POC_BROWSER=chrome DSH_POC_LLM=real DSH_POC_ENV_FILE=docs/drafts/.env \
  node docs/drafts/browser-native-dsh-poc/tests/image-attachment.e2e.mjs
node --test docs/drafts/browser-native-dsh-poc/tests/backend-v2.test.mjs
```
