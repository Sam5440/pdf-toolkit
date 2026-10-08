# 文件床 CORS 中转：Cloudflare Worker 部署指南

## 背景

「文件床」工具默认服务 [img.yohuo.eu.org](https://img.yohuo.eu.org/)（开源 telegraph 实例）
的响应**没有 CORS 头**：浏览器可以把文件 POST 出去（服务端会正常存储），但页面 JS
读不到返回的分享链接。这是服务端配置，本页无法单方面解开。

三条路（按推荐顺序）：

| 方案 | 成本 | 效果 |
|---|---|---|
| ① 工具内切换内置服务 onlyfiles.com / tmpfiles.org | 零 | 立即可全自动直传取链（onlyfiles 永久 / tmpfiles 60 分钟）；分享链接为预览页，无稳定直链嵌图 |
| ② 自部署 Cloudflare Worker 中转（本文） | 约 10 分钟 | 保留 yohuo 的稳定直链，全自动上传取链 |
| ③ 自部署完整 telegraph 实例 | 较高 | 同 ②，且完全自主可控 |

## 方案 ②：Worker 中转（约 10 分钟，免费额度足够个人使用）

原理：你自己有一个 Cloudflare Worker，把发往它的请求原样转发给
`img.yohuo.eu.org`，并在响应上补 `Access-Control-Allow-Origin: *`。
文件流经**你自己的** Worker（Cloudflare），不经过任何其它第三方。

### Worker 代码（与工具内「复制 Worker 代码」按钮内容一致）

```js
// Cloudflare Worker：文件床 CORS 中转
// 部署后把 Worker 地址（如 https://filebed-proxy.你的子域.workers.dev）填入工具的「自定义端点」
const UPSTREAM = 'https://img.yohuo.eu.org';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const resp = await fetch(UPSTREAM + url.pathname + url.search, request);
    const headers = new Headers(resp.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(resp.body, { status: resp.status, headers });
  },
};
```

> `fetch(UPSTREAM + …, request)` 是 Cloudflare Workers 的经典用法：method / headers /
> multipart body 会原样转发给上游，无需手动解析表单。

### 步骤 A：Dashboard 粘贴部署（无需装任何命令行）

1. 注册/登录 [dash.cloudflare.com](https://dash.cloudflare.com)（免费套餐即可）。
2. 左侧 **Workers & Pages → Create application → Create Worker**，名字随意
   （如 `filebed-proxy`），点 **Deploy**。
3. 部署后点 **Edit code**，清空示例代码，粘贴上面的 Worker 代码，点右上 **Deploy**。
4. 记下 Worker 地址（形如 `https://filebed-proxy.<你的子域>.workers.dev`）。

### 步骤 B：wrangler 命令行部署（可选，适合已装 Node 的用户）

```bash
npm i -g wrangler
wrangler login
mkdir filebed-proxy && cd filebed-proxy
# 把上面的 Worker 代码存为 worker.js，然后：
wrangler deploy worker.js --name filebed-proxy --compatibility-date 2026-01-01
```

### 接入工具

打开「文件床」工具 → 「上传服务」选 **自定义端点** → 「服务地址」填
`https://filebed-proxy.<你的子域>.workers.dev` → 正常选文件上传。
端点会以 `/upload` 结尾转发到 yohuo，响应已带 CORS 头，页面自动取回
`src.yohuo.eu.org` 稳定直链（可直接嵌 Markdown / HTML）。

### 验证

```bash
curl -D - -o /dev/null -X OPTIONS "https://filebed-proxy.<子域>.workers.dev/upload" \
  -H "Origin: https://pdftools.isam.top" -H "Access-Control-Request-Method: POST"
# 期望：HTTP 204 且响应头含 access-control-allow-origin: *
```

### 注意事项

- Cloudflare 免费套餐每天 10 万次请求，个人使用绰绰有余；请求体上限 100MB。
- Worker 对上游 yohuo 的可用性没有加成：yohuo 挂了中转同样 502。
- 中转地址若被他人滥用刷量，可在 Worker 里加一段 `Origin` 白名单校验（可选加固）。
- 本工具全站唯一联网；其余工具仍全部本地处理，文件不出浏览器。
