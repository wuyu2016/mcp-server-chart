# MCP Server Chart 私有化部署指南

> 面向运维 / 后端同学的完整部署手册。覆盖架构、前置条件、三种部署方式、环境变量、
> 图片返回形式（公开桶 vs 预签名）、客户端接入、Nginx/HTTPS、运维与排障。
>
> 本文所有端口、环境变量与实际代码/compose 文件一一对应（见文末「验证记录」）。

## 目录

| # | 章节 | 你会得到什么 |
| --- | --- | --- |
| 1 | [适用范围](#-1-适用范围) | 本分支相对上游多出的能力、以及哪些镜像不含这些能力 |
| 2 | [架构与端口](#-2-架构与端口) | 组件、数据流、两套 compose 的端口差异表 |
| 3 | [前置条件](#-3-前置条件) | Docker/Node 版本、OSS + RAM 最小权限、资源参考值 |
| 4 | [部署方式一：Docker Compose（推荐）](#-4-部署方式一docker-compose推荐) | 一键部署 + 四步验证命令 |
| 5 | [部署方式二：`docker/` 目录（三服务）](#-5-部署方式二docker-目录三服务) | 同时提供 SSE 与 streamable |
| 6 | [部署方式三：Node 直接运行](#-6-部署方式三node-直接运行不使用容器) | 裸机/K8s 自行编排 |
| 7 | [环境变量参考](#-7-环境变量参考) | MCP 服务与渲染服务的全部变量 |
| 8 | [图片返回形式：公开桶 vs 预签名](#-8-图片返回形式公开桶-vs-预签名) | 新开关怎么用、权限怎么配、有效期怎么定 |
| 9 | [客户端接入](#-9-客户端接入) | Cursor / Cline / stdio / CLI 的配置片段 |
| 10 | [Nginx 反向代理与 HTTPS](#-10-nginx-反向代理与-https) | 反代要点、TLS、健康检查 |
| 11 | [图表默认样式](#-11-图表默认样式defaultsjson) | 统一尺寸/主题/配色 |
| 12 | [运维](#-12-运维) | 日志、升级、资源限制、OSS 生命周期清理 |
| 13 | [故障排查](#-13-故障排查) | 15+ 常见现象 → 原因 → 处理 |
| 14 | [安全清单](#-14-安全清单) | 上线前逐条确认 |
| 15 | [附录](#-15-附录) | 命令速查、文件清单、接口契约、验证记录 |

---

## 📌 1. 适用范围

本仓库是上游 [`@antv/mcp-server-chart`](https://github.com/antvis/mcp-server-chart) 的**私有化部署分支**，
在原有能力之上增加了：

| 增量能力 | 说明 | 相关文件 |
| --- | --- | --- |
| 内置渲染服务 | `gpt-vis-ssr` + 阿里云 OSS，实现「渲染 → 上传 → 返回图片 URL」闭环 | `docker/gpt-vis-ssr/` |
| HTTP 鉴权 | `MCP_API_KEY` + `Authorization: Bearer <key>` | `src/utils/auth.ts` |
| 图表默认样式 | `defaults.json` 集中管理主题/尺寸/配色 | `docker/gpt-vis-ssr/defaults.json` |
| 图片返回形式可切换 | 公开桶直链（默认）或 OSS 预签名临时链接 | `docker/gpt-vis-ssr/server.js` |
| 反向代理 | Nginx 反代 streamable / SSE 与 HTTPS 模板 | `nginx.conf` |

> ⚠️ **重要**：本分支的 `src/utils/auth.ts`（`MCP_API_KEY`）与 `docker/gpt-vis-ssr/` 均为**本仓库本地提交，
> 未发布到 npm**。因此 `docker/sse/Dockerfile`、`docker/streamable/Dockerfile` 这类
> 「`npm install -g @antv/mcp-server-chart`」的镜像**不包含**鉴权与 OSS 渲染能力，
> 详见 [§5](#-5-部署方式二docker-目录三服务)。

---

## 🏗️ 2. 架构与端口

### 2.1 组件

| 组件 | 端口（容器内） | 作用 | 是否必须 |
| --- | --- | --- | --- |
| `mcp-server-chart` | `1122`（streamable）/ `1123`（SSE） | MCP 协议服务端，向客户端暴露图表工具 | ✅ |
| `gpt-vis-ssr` | `3000` | 图表渲染 + 上传 OSS + 返回图片 URL | ✅ |
| 阿里云 OSS | - | 图片对象存储 | ✅ |
| Nginx | `80` / `443` | 反向代理、TLS 终结、访问控制 | 公网部署建议 |

### 2.2 数据流

```
┌──────────────┐   ① MCP 调用（tools/call）    ┌────────────────────┐
│ MCP Client   │ ────────────────────────────► │ mcp-server-chart   │
│ (Cursor /    │                               │ :1122 /mcp         │
│  Cline /     │   ⑤ 返回图片 URL              │ :1123 /sse         │
│  Cherry ...) │ ◄──────────────────────────── │                    │
└──────────────┘                               └─────────┬──────────┘
                                                         │ ② POST 图表配置
                                                         ▼
                     ┌────────────────┐  ③ 上传 PNG   ┌──────────────────┐
                     │ 阿里云 OSS      │ ◄──────────── │ gpt-vis-ssr      │
                     │ Bucket         │               │ :3000 /render    │
                     └───────┬────────┘               └──────────────────┘
                             │ ④ 图片 URL（公开直链 / 预签名）
                             └──────────────► 返回给 ②（再由 ⑤ 交给客户端）
```

要点：**图片 URL 由渲染服务生成**，`mcp-server-chart` 只是原样透传 `resultObj`。
所以「公开桶还是预签名」只需要改渲染服务一处（见 [§8](#-8-图片返回形式公开桶-vs-预签名)）。

### 2.3 两套 Compose 的端口差异（易踩坑）

| 文件 | 渲染服务端口（宿主机） | MCP 端口 | 说明 |
| --- | --- | --- | --- |
| `docker-compose.yaml`（仓库根） | **3303** → 容器 3000 | 1122 | 渲染 + MCP（streamable）两个服务 |
| `docker/docker-compose.yml` | **3000** → 容器 3000 | 1122 / 1123 | 渲染 + SSE + streamable 三个服务 |

> 📎 因此健康检查地址不同：根目录方式是 `http://localhost:3303/health`，
> `docker/` 目录方式是 `http://localhost:3000/health`。请勿混用。

---

## ✅ 3. 前置条件

### 3.1 运行环境

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Docker Engine | 20.10+ | `docker version` |
| Docker Compose | v2（`docker compose` 子命令形式） | `docker compose version` |
| Node.js | ≥ 18（**仅**非容器方式需要） | `node -v` |
| 磁盘 | ≥ 2 GB（渲染服务含 Canvas 原生依赖与中文字体） | - |

### 3.2 阿里云 OSS 准备

1. 创建一个 Bucket（与部署机同地域可降低延迟，如 `oss-cn-hangzhou`）。
2. 创建 **RAM 子账号**并只授予最小权限（不要用主账号 AK）：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject"],
      "Resource": ["acs:oss:*:*:<your-bucket>/charts/*"]
    }
  ]
}
```

> 说明：渲染服务只做 `PutObject`；生成预签名链接是**本地签名计算，不需要额外 RAM 权限**。
> `Resource` 中的 `charts/*` 请与 `OSS_PATH_PREFIX` 保持一致。

3. 记录：`region`、`bucket 名称`、`AccessKeyId`、`AccessKeySecret`。

### 3.3 Bucket 读写权限与「图片能不能打开」直接相关

| 模式 | Bucket/对象权限 | 效果 |
| --- | --- | --- |
| `OSS_SIGNED_URL_ENABLED=false`（默认） | 必须 **公共读**（`public-read`） | 返还的直链任何人可访问 |
| `OSS_SIGNED_URL_ENABLED=true` | 建议 **私有**（`private`） | 返还带签名的临时链接，到期失效 |

> ❗ 私有桶 + 默认（直链）模式 = 客户端拿到链接后会 **403 AccessDenied**。这是最常见的问题，见 [§8](#-8-图片返回形式公开桶-vs-预签名) 与 [§13](#-13-故障排查)。

### 3.4 资源参考值

以下为**经验参考值，非实测指标**，请按并发压测调整：

| 服务 | CPU | 内存 | 说明 |
| --- | --- | --- | --- |
| `gpt-vis-ssr` | 1 ~ 2 vCPU | 1 ~ 2 GB | 无头 Canvas 渲染，并发渲染时 CPU 峰值明显 |
| `mcp-server-chart` | 0.25 ~ 0.5 vCPU | 256 ~ 512 MB | 主要是 HTTP 转发，开销低 |

---

## 🚀 4. 部署方式一：Docker Compose（推荐）

适合：完全私有化、需要鉴权、单机部署。

### 4.1 步骤

```bash
# 1) 获取代码
git clone <your-repo-url> mcp-server-chart
cd mcp-server-chart

# 2) 生成配置文件
cp .env.example .env

# 3) 编辑 .env（至少填 OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET）
#    vim .env

# 4) 构建并启动
docker compose up -d --build

# 5) 查看状态
docker compose ps
```

### 4.2 `.env` 必填项

| 变量 | 必填 | 示例 |
| --- | --- | --- |
| `OSS_REGION` | ✅ | `oss-cn-hangzhou` |
| `OSS_BUCKET` | ✅ | `my-chart-bucket` |
| `OSS_ACCESS_KEY_ID` | ✅ | `LTAI5t****` |
| `OSS_ACCESS_KEY_SECRET` | ✅ | `****` |
| `MCP_API_KEY` | 公网部署建议填 | `sk-abc123`（不填 = 不鉴权） |

完整变量说明见 [§7](#-7-环境变量参考)。

### 4.3 验证部署

```bash
# ① 渲染服务健康检查（根目录 compose 映射到 3303）
curl http://localhost:3303/health
# {"status":"ok"}

# ② 直接调用渲染服务，确认 OSS 上传与 URL 生成正常
curl -sS -X POST http://localhost:3303/render \
  -H 'Content-Type: application/json' \
  -d '{"type":"line","data":[{"time":"2025-05","value":512},{"time":"2025-06","value":1024}]}'
# {"success":true,"resultObj":"https://<bucket>.oss-cn-hangzhou.aliyuncs.com/charts/1750000000000-ab12cd34.png"}

# ③ 拿到 URL 后立刻用浏览器/curl 打开，确认可访问（权限问题在这一步暴露）
curl -I "https://<bucket>.oss-cn-hangzhou.aliyuncs.com/charts/1750000000000-ab12cd34.png"

# ④ 列出 MCP 工具（需 MCP_API_KEY 时带上鉴权头）
curl -sS -X POST http://localhost:1122/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer sk-abc123' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期：④ 返回 **27 个工具**（`generate_line_chart`、`generate_pie_chart` …）。

> 💡 本服务是 **stateless**（每个请求创建独立 transport），因此 `tools/list` **无需先 `initialize`**，
> 可直接调用。鉴权开启时，缺失鉴权头返回 `401 Missing Authorization header`，
> key 错误返回 `403 Invalid API key`。

### 4.4 对外提供的接入地址

- Streamable HTTP：`http://<host>:1122/mcp`

---

## 🧩 5. 部署方式二：`docker/` 目录（三服务）

适合：**同时**需要 SSE 与 streamable 两种传输的客户端。

```bash
cd docker
cp ../.env.example ../.env   # 若尚未创建
docker compose up -d --build
```

| 服务 | 宿主机端口 | 接入地址 |
| --- | --- | --- |
| `gpt-vis-ssr` | 3000 | 健康检查 `http://localhost:3000/health` |
| `streamable` | 1122 | `http://localhost:1122/mcp` |
| `sse` | 1123 | `http://localhost:1123/sse` |

> ⚠️ **关键差异**：`docker/sse/Dockerfile` 与 `docker/streamable/Dockerfile` 使用
> `npm install -g @antv/mcp-server-chart` 安装 **npm 上已发布的官方版本**，
> 不包含本仓库的本地改动（`MCP_API_KEY` 鉴权等）。
>
> - 需要鉴权 / 需要与本地代码一致 → 用 [§4 根目录 compose](#-4-部署方式一docker-compose推荐)。
> - 只是想让客户端用 SSE → 也可直接用根目录镜像改传输方式：
>   `command: ["node","build/index.js","--transport","sse","--port","1123","--host","0.0.0.0"]`

---

## 💻 6. 部署方式三：Node 直接运行（不使用容器）

适合：已有独立渲染服务，只想跑 MCP 服务端；或在 Kubernetes 中自行编排。

### 6.1 安装与构建

```bash
# 方式 A：全局安装已发布版本（不含本仓库改动）
npm install -g @antv/mcp-server-chart

# 方式 B：从本仓库构建（含鉴权等本地改动）
npm install
npm run build
```

> 🪟 **Windows 提示**：`npm run build` 的 `prebuild` 使用了 `rm -rf`，在 PowerShell/CMD 下会失败。
> 可在 WSL / Git Bash 中执行，或绕过脚本手动编译：
>
> ```powershell
> node node_modules/typescript/bin/tsc
> node node_modules/tsc-alias/dist/bin/index.js -p tsconfig.json
> ```

### 6.2 启动与 CLI 参数

```bash
# streamable（对外提供 /mcp）
node build/index.js --transport streamable --host 0.0.0.0 --port 1122

# SSE（默认端点 /sse）
node build/index.js -t sse -h 0.0.0.0 -p 1123

# 查看帮助
node build/index.js -H
```

| 参数 | 简写 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--transport` | `-t` | `stdio` | `stdio` / `sse` / `streamable` |
| `--host` | `-h` | `localhost` | 监听地址。**容器/对外服务必须改为 `0.0.0.0`** |
| `--port` | `-p` | `1122` | 监听端口 |
| `--endpoint` | `-e` | streamable→`/mcp`，sse→`/sse` | HTTP 端点路径 |
| `--help` | `-H` | - | 显示帮助 |

> ❗ 根目录 `Dockerfile` 的默认 `CMD` 是 `node build/index.js -t streamable`（**host 仍是 localhost**）。
> 若用 `docker run -p 1122:1122` 直接跑该镜像，**必须**追加 `--host 0.0.0.0`，否则宿主机连不上。
> 官方 compose 已代你传好该参数。

### 6.3 与独立渲染服务组合

```bash
VIS_REQUEST_SERVER=http://render-host:3000/render \
MCP_API_KEY=sk-abc123 \
node build/index.js -t streamable -h 0.0.0.0 -p 1122
```

---

## ⚙️ 7. 环境变量参考

### 7.1 MCP 服务（`mcp-server-chart`）

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `VIS_REQUEST_SERVER` | 私有化必填 | `https://antv-studio.alipay.com/api/gpt-vis`（官方公网服务） | 图表渲染服务地址。**不设置则图表配置会发往公网官方服务** |
| `MCP_API_KEY` | 公网建议填 | - | HTTP 传输鉴权开关。设置后客户端须带 `Authorization: Bearer <key>`；**不设置 = 完全开放** |
| `SERVICE_ID` | 否 | - | 生成记录服务标识（配合官方小程序查看记录） |
| `DISABLED_TOOLS` | 否 | - | 逗号分隔的工具名黑名单，如 `generate_mind_map,generate_fishbone_diagram` |

### 7.2 渲染服务（`gpt-vis-ssr`）

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `OSS_REGION` | ✅ | 代码内无默认值（compose 传入 `oss-cn-hangzhou`） | Bucket 地域 |
| `OSS_BUCKET` | ✅ | - | Bucket 名称 |
| `OSS_ACCESS_KEY_ID` | ✅ | - | AccessKey ID |
| `OSS_ACCESS_KEY_SECRET` | ✅ | - | AccessKey Secret |
| `OSS_ENDPOINT` | 否 | 由 region 推导 | 自定义 Endpoint。**设置后优先于 region**；使用内网域名有额外注意点，见 [§8.5](#85-易踩坑内网-endpoint) |
| `OSS_PATH_PREFIX` | 否 | `charts` | 对象 Key 前缀。最终 Key 为 `<前缀>/<时间戳>-<随机串>.png` |
| `OSS_SIGNED_URL_ENABLED` | 否 | `false` | `false` = 公开桶直链；**`true` = 返回 OSS 预签名链接** |
| `OSS_SIGNED_URL_EXPIRES` | 否 | `3600` | 预签名链接有效期（秒），仅 `OSS_SIGNED_URL_ENABLED=true` 时生效 |
| `PORT` | 否 | `3000` | 渲染服务监听端口（监听 `0.0.0.0`） |

> 关于 `OSS_REGION` 的取值：`.env.example` 与 README 使用 `oss-cn-hangzhou` 这种带 `oss-` 前缀的写法（推荐）。
> 若同时设置了 `OSS_ENDPOINT`，则以 Endpoint 为准。

---

## 🖼️ 8. 图片返回形式：公开桶 vs 预签名

### 8.1 开关

```env
# 默认：公开桶 + 对象路径直链
OSS_SIGNED_URL_ENABLED=false

# 改为预签名链接（私有桶场景）
OSS_SIGNED_URL_ENABLED=true
OSS_SIGNED_URL_EXPIRES=3600
```

改完后重建渲染服务使变量生效：

```bash
docker compose up -d --build gpt-vis-ssr
# 或仅重启（变量来自 .env，无需重建镜像）
docker compose up -d --force-recreate gpt-vis-ssr
```

启动日志会明确打印当前模式，可据此确认：

```
Image URL mode: public bucket URL
# 或
Image URL mode: signed (expires in 3600s)
```

### 8.2 两种模式对比

| 维度 | `false`（默认，公开桶直链） | `true`（预签名） |
| --- | --- | --- |
| URL 形态 | `https://<bucket>.<endpoint>/charts/xxx.png` | `https://<bucket>.<endpoint>/charts/xxx.png?OSSAccessKeyId=...&Expires=...&Signature=...` |
| 生成方式 | `put()` 返回的 `result.url` | `ossClient.signatureUrl(key, { expires })` |
| Bucket 权限要求 | **公共读**，否则 403 | 私有读即可（签名即授权） |
| 时效性 | 永久可访问（除非对象被删/生命周期清理） | 到期后链接失效 |
| 泄露风险 | 链接被转发后长期有效，任何人可访问 | 链接被转发后仅在有效期内可用 |
| 客户端/客户端缓存 | 无感知 | 需在有效期内访问 |
| 适用场景 | 内部工具、公开演示、已接受公开读的桶 | 私有数据、合规要求、外发链接可控 |

### 8.3 如何选择

- Bucket 是**私有读** → 必须 `OSS_SIGNED_URL_ENABLED=true`，否则用户拿到链接打不开。
- Bucket 是**公共读** 但有合规/防扩散诉求 → 建议开启预签名，并可把桶改回私有读。
- 只是内部试用、图省事 → 保持默认 `false`（但记得桶要公共读）。

### 8.4 有效期怎么设

| `OSS_SIGNED_URL_EXPIRES` | 影响 |
| --- | --- |
| 过短（如 300） | 用户/AI 客户端稍后再打开就 403，体验差 |
| 默认 `3600`（1 小时） | 适合「生成后立刻查看」的主流用法 |
| 过长（如 7 天） | 接近直链的暴露面，私有化收益下降 |

> 建议：默认 3600 起步；若你的客户端存在「生成后延迟渲染/二次抓取」的行为，调到 `86400`。
> 过期后 OSS 会返回 `403`（`AccessDenied` 类错误，提示签名过期）——重新生成一次图表即可。

### 8.5 易踩坑：内网 Endpoint

图片 URL 是基于 `OSS_ENDPOINT` 拼出来的。如果把 `OSS_ENDPOINT` 配成
**内网域名**（如 `https://oss-cn-hangzhou-internal.aliyuncs.com`，用于省流量费）：

- 容器内上传会成功（走内网、更快更省）；
- 但**返回给用户的链接也是内网域名**，公网客户端/AI 客户端**打不开**（两种模式都一样）。

结论：**客户端要访问图片时，不要使用内网 Endpoint**。若必须走内网，请让 MCP 客户端也运行在同一内网，
或额外加一层公网网关/自定义域名来转换图片地址。

### 8.6 代码位置（便于二次开发）

| 位置 | 作用 |
| --- | --- |
| `docker/gpt-vis-ssr/server.js:36-44` | 读取并解析 `OSS_SIGNED_URL_ENABLED` / `OSS_SIGNED_URL_EXPIRES` |
| `docker/gpt-vis-ssr/server.js:93-98` | 按模式选择 `signatureUrl()` 或 `result.url` 并写入 `resultObj` |
| `docker-compose.yaml`、`docker/docker-compose.yml` | 变量透传到容器 |

> 兼容性：默认值为 `false`，且未设置该变量时行为与改动前完全一致，**升级不会影响既有部署**。

---

## 🔌 9. 客户端接入

### 9.1 远程 HTTP（streamable，推荐）

支持 `url` 的客户端（Cursor、Cline、Cherry Studio、VS Code 等）：

```json
{
  "mcpServers": {
    "mcp-server-chart": {
      "url": "https://mcp-chart.example.com/mcp",
      "headers": {
        "Authorization": "Bearer sk-abc123"
      }
    }
  }
}
```

- `url` 需指向 **`/mcp`** 端点（streamable 默认端点）。
- `headers` 中的 `Authorization` 仅当服务端设置了 `MCP_API_KEY` 才需要；未设置时留空即可。
- 若前面有 Nginx 且已启用 HTTPS，请使用 `https://` 域名，不要直接暴露容器端口。

### 9.2 SSE（老客户端）

```json
{
  "mcpServers": {
    "mcp-server-chart": {
      "url": "https://mcp-chart.example.com/sse",
      "headers": {
        "Authorization": "Bearer sk-abc123"
      }
    }
  }
}
```

> 注意：SSE 传输除 `GET /sse` 外还会用到 `POST /messages?sessionId=...`，
> 反向代理时需把**两者都**转发到同一个后端（`§10` 的 `location /` 方案已覆盖）。
> 另：SSE 服务未启用 CORS，浏览器直连场景需自行处理。

### 9.3 仅支持 stdio 的客户端

```json
{
  "mcpServers": {
    "mcp-server-chart": {
      "command": "npx",
      "args": ["-y", "@antv/mcp-server-chart"],
      "env": {
        "VIS_REQUEST_SERVER": "http://render-host:3000/render"
      }
    }
  }
}
```

Windows 系统需要改为：

```json
{
  "mcpServers": {
    "mcp-server-chart": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@antv/mcp-server-chart"]
    }
  }
}
```

> 若客户端只支持 stdio 但要连远程 HTTP 服务，可用社区代理 `mcp-remote` 转发：
> `npx -y mcp-remote https://mcp-chart.example.com/mcp --header "Authorization: Bearer sk-abc123"`

### 9.4 命令行客户端（Claude Code）

```bash
claude mcp add --transport http mcp-server-chart \
  https://mcp-chart.example.com/mcp \
  --header "Authorization: Bearer sk-abc123"
```

---

## 🌐 10. Nginx 反向代理与 HTTPS

仓库自带 `nginx.conf`（反代 + HTTPS 模板，默认监听 80、`server_name mcp-chart.example.com`）。

```bash
# 作为独立 conf.d 文件挂载
cp nginx.conf /etc/nginx/conf.d/mcp-chart.conf
nginx -t && systemctl reload nginx
```

### 10.1 使用要点

| 项 | 说明 |
| --- | --- |
| `upstream` 地址 | Nginx 与容器**同宿主机**：`127.0.0.1:1122`（默认，配 `docker compose` 的端口映射）；Nginx 也在 compose 网络内：改为容器名 `mcp-server-chart-1:1122` |
| `proxy_buffering off` | **必须**。Streamable HTTP 为流式响应，开启缓冲会导致响应被攒住 |
| `chunked_transfer_encoding on` | 保证流式分块传输 |
| `proxy_read_timeout 3600s` | MCP 会话可能长时间挂起，超时过短会频繁断连 |
| `client_max_body_size 10m` | 需 ≥ 渲染服务的 `express.json({ limit: "10mb" })`，否则大图表请求 413 |
| `/health` | **Nginx 自身返回** `200 OK`，不代表后端健康（见 §10.3） |

### 10.2 HTTPS

`nginx.conf` 末尾提供了 443 + TLS 1.2/1.3 的注释模板：填入证书路径、取消注释、
把 `server_name` 换成真实域名即可。对外提供 MCP 服务时**强烈建议启用 HTTPS**，
否则 `MCP_API_KEY` 会以明文经网络传输。

### 10.3 健康检查怎么配

| 目标 | 探测方式 | 说明 |
| --- | --- | --- |
| 渲染服务 | `GET http://<host>:3303/health` → `{"status":"ok"}` | 真实健康检查 |
| MCP 服务 | **TCP 1122** 探活，或 Nginx 的 `/health` | ⚠️ MCP 服务**没有** HTTP 健康端点；`GET /mcp` 也不可用（仅支持 `POST`），不要用它做探活 |
| Nginx | `GET /health` | 只证明 Nginx 存活 |

---

## 🎨 11. 图表默认样式（`defaults.json`）

无需改代码即可统一所有图表的尺寸、主题与配色。合并优先级（后者覆盖前者）：

```
global  →  perType.<chart>  →  MCP 请求体
```

```json
{
  "global": {
    "width": 600,
    "height": 400,
    "theme": "default",
    "style": {
      "backgroundColor": "#ffffff",
      "palette": ["#1783FF", "#00C9C9", "#F0884D", "#D580FF", "#7863FF"]
    }
  },
  "perType": {
    "line": { "style": { "lineWidth": 2, "startAtZero": false } },
    "area": { "style": { "startAtZero": false } }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `global` | object | 所有图表类型的默认值 |
| `global.theme` | string | `default` / `academy` / `dark` |
| `global.style.palette` | array | 全局色板 |
| `perType.<chart>` | object | 按图表类型覆盖，键为图表类型（`line`、`bar`、`pie`…） |

当前文件内置了 24 个 `perType` 条目：`line`、`area`、`bar`、`column`、`pie`、`scatter`、
`radar`、`funnel`、`histogram`、`boxplot`、`violin`、`waterfall`、`dual-axes`、`sankey`、
`treemap`、`venn`、`liquid`、`word-cloud`、`spreadsheet`、`mind-map`、`flow-diagram`、
`fishbone-diagram`、`network-graph`、`organization-chart`。

改完需要重建镜像（该文件通过 `COPY` 打进镜像）：

```bash
docker compose up -d --build gpt-vis-ssr
```

> `defaults.json` 存在语法错误时服务不会崩溃：会打印 `Failed to load defaults.json, using empty defaults`
> 并退化为无默认样式运行，属正常降级。

---

## 🛠️ 12. 运维

### 12.1 常用操作

```bash
docker compose ps                       # 状态
docker compose logs -f gpt-vis-ssr      # 渲染服务日志（渲染错误、OSS 报错）
docker compose logs -f mcp-server-chart # MCP 服务日志（鉴权失败会打 warn）
docker compose restart gpt-vis-ssr      # 重启
docker compose up -d --build            # 升级/改代码后重建
docker compose down                     # 停止（保留数据卷）
```

### 12.2 资源限制示例

```yaml
services:
  gpt-vis-ssr:
    deploy:
      resources:
        limits:
          cpus: "2.0"
          memory: 2G
        reservations:
          memory: 512M
```

### 12.3 OSS 对象清理（重要）

渲染产物 Key 形如 `charts/<时间戳>-<随机串>.png`，**服务不会自动删除**，长期运行会持续占用存储。
建议在 OSS 控制台为 `charts/` 前缀配置**生命周期规则**（例如 30 天后自动删除或转低频/归档）。
若开启了预签名模式且只用于临时查看，可把保留期设得更短。

### 12.4 备份

`.env` 内包含 OSS AK/SK 与 `MCP_API_KEY`，需按密钥资产保存（如内部密钥管理系统）。
该文件已在 `.gitignore` 中，**切勿提交到代码仓库**。

---

## 🧯 13. 故障排查

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 客户端连接 401 `Missing Authorization header` | 客户端未带 `Authorization` 头，但服务端设了 `MCP_API_KEY` | 在客户端 `headers` 中补 `Authorization: Bearer <key>` |
| 客户端连接 403 `Invalid API key` | key 不匹配（含多余空格/引号） | 核对 `.env` 与客户端配置，注意不要带引号 |
| `GET /mcp` 返回 404 | Streamable 端点仅注册了 `POST` 路由 | 正常现象；健康检查改用 TCP 探活，不要用 GET |
| 图片链接 403 AccessDenied | 桶是私有读，却用的是默认直链模式 | 设 `OSS_SIGNED_URL_ENABLED=true`；或把桶改为公共读 |
| 图片链接 403 且提示签名过期 | 预签名有效期太短，用户/AI 稍后才打开 | 增大 `OSS_SIGNED_URL_EXPIRES`（如 `86400`） |
| 图片打不开，但 `curl` 在服务器上能打开 | `OSS_ENDPOINT` 用了内网域名 | 换公网 Endpoint，见 §8.5 |
| 渲染请求 413 / 请求体过大 | 图表数据超过 10MB 限制 | 精简数据；如需调大，需同时改 `server.js` 的 `express.json({ limit })`、Nginx `client_max_body_size` 与中间网关 |
| 图表中文变方块/乱码 | 镜像缺少中文字体 | 使用本仓库 `docker/gpt-vis-ssr/Dockerfile`（已内置 `fonts-wqy-microhei`）构建 |
| 渲染服务构建失败（canvas 原生依赖） | 缺少系统编译依赖 | 使用该 Dockerfile（已装 `build-essential`、`libcairo2-dev`、`libpango1.0-dev` 等） |
| 容器内 `VIS_REQUEST_SERVER=http://localhost:3000/render` 连接失败 | 容器内 `localhost` 指容器自身 | 同一 compose 网络内应写服务名：`http://gpt-vis-ssr:3000/render` |
| 地图类工具报错 | 私有渲染服务**不支持** 3 个地理可视化工具 | `generate_district_map` / `generate_path_map` / `generate_pin_map` 需官方服务，或用 `DISABLED_TOOLS` 显式关闭 |
| 端口被占用（1122/1123/3000/3303） | 宿主机已有服务占用 | 改 compose 的宿主机端口映射（左侧数字），如 `"18122:1122"` |
| Windows 上 `npm run build` 报 `'rm' is not recognized` | `prebuild` 使用 `rm -rf` | 用 WSL/Git Bash，或手动执行 `tsc` + `tsc-alias`，见 §6.1 |
| 改了 `.env` 但不生效 | 容器未重建 | `docker compose up -d --force-recreate gpt-vis-ssr` |

---

## 🔐 14. 安全清单

上线前请逐条确认：

- [ ] **开启了 `MCP_API_KEY`**（未设置 = HTTP 端口完全开放），并使用足够长的随机串。
- [ ] **对外一律走 HTTPS**（Nginx），避免 `Bearer` 明文传输。
- [ ] **渲染服务 `gpt-vis-ssr:3000` 不对公网暴露**：它**没有任何鉴权**，且 CORS 为 `*`，
      仅在内网/MCP 服务内可达即可（官方 compose 通过 Docker 网络隔离，不要额外把 3000 映射到公网）。
- [ ] OSS 使用 **RAM 子账号 + 最小权限**（仅 `oss:PutObject`），定期轮转 AK。
- [ ] 私有桶场景启用 `OSS_SIGNED_URL_ENABLED=true`，避免长期有效直链泄露。
- [ ] 为 `charts/` 配置 **OSS 生命周期清理**，避免存储无限增长。
- [ ] `.env` 不入库、不进镜像层、不进日志；已在 `.gitignore` 中，提交前用 `git status` 复核。
- [ ] 按需限制来源：Nginx 层做 IP 白名单 / 限流（`limit_req`），或前置网关统一鉴权。
- [ ] 如需收敛能力面，用 `DISABLED_TOOLS` 关闭不需要的工具。

---

## 📎 15. 附录

### 15.1 命令速查

```bash
# 启动 / 停止
docker compose up -d --build && docker compose ps
docker compose down

# 健康与自检
curl http://localhost:3303/health
curl -sS -X POST http://localhost:3303/render -H 'Content-Type: application/json' \
  -d '{"type":"pie","data":[{"category":"A","value":27},{"category":"B","value":25}]}'

# 列出工具（27 个）
curl -sS -X POST http://localhost:1122/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 观察当前图片返回模式
docker compose logs gpt-vis-ssr | Select-String "Image URL mode"   # Windows
docker compose logs gpt-vis-ssr | grep "Image URL mode"            # Linux/macOS
```

### 15.2 关键文件清单

| 路径 | 说明 |
| --- | --- |
| `docker-compose.yaml` | 根目录：渲染服务 + MCP 服务（streamable） |
| `docker/docker-compose.yml` | 渲染服务 + SSE + streamable 三服务 |
| `.env.example` | 全部环境变量模板（含图片模式开关） |
| `docker/gpt-vis-ssr/server.js` | 渲染 → 上传 OSS → 生成 URL 的核心逻辑 |
| `docker/gpt-vis-ssr/Dockerfile` | 渲染服务镜像（Canvas 原生依赖 + 中文字体） |
| `docker/gpt-vis-ssr/defaults.json` | 图表默认样式 |
| `Dockerfile` | MCP 服务镜像（多阶段，非 root 用户 `appuser`，`EXPOSE 1122`） |
| `nginx.conf` | 反向代理 + HTTPS 模板 |
| `src/utils/auth.ts` | `MCP_API_KEY` 鉴权中间件 |
| `src/utils/env.ts` | `VIS_REQUEST_SERVER` / `SERVICE_ID` / `DISABLED_TOOLS` 读取 |

### 15.3 接口契约

**渲染服务 `POST /render`**

| 方向 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 请求 | `type` | string | 图表类型，如 `line`、`pie`（必填） |
| 请求 | `data` | array | 数据 |
| 请求 | 其他字段 | any | 尺寸/主题/样式等，按 `defaults.json` 同级合并 |
| 响应（成功） | `success` | boolean | `true` |
| 响应（成功） | `resultObj` | string | 图片 URL（直链或预签名，取决于开关） |
| 响应（失败） | `success` | boolean | `false` |
| 响应（失败） | `errorMessage` | string | 错误信息 |

**渲染服务 `GET /health`** → `{"status":"ok"}`

**MCP 服务**：`POST /mcp`（streamable）、`GET /sse` + `POST /messages`（SSE）。
鉴权开启时两者均要求 `Authorization: Bearer <MCP_API_KEY>`。

### 15.4 验证记录（本文档的准确性依据）

已在本机实测：

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 渲染服务代码语法 | `node --check docker/gpt-vis-ssr/server.js` | 通过 |
| 图片模式开关解析 | 覆盖 `""` / `false` / `False` / `true` / `TRUE` / `1` | 仅 `true`/`TRUE` 为真，默认 `false` |
| Compose 变量透传 | `docker compose config` | `OSS_SIGNED_URL_ENABLED: "false"`、`OSS_SIGNED_URL_EXPIRES: "3600"` 正确解析 |
| 未鉴权访问 | `POST /mcp`（无 `Authorization`） | `401 {"error":"Missing Authorization header"}` |
| 错误 key | `POST /mcp`（`Bearer nope`） | `403 {"error":"Invalid API key"}` |
| stateless 无需握手 | `POST /mcp` 直接 `tools/list`（未先 `initialize`） | `200`，正常返回工具列表 |
| `initialize` | `POST /mcp` | `200`，`protocolVersion: 2025-03-26` |
| 默认工具数 | `tools/list` | **27 个** |
| `DISABLED_TOOLS` 生效 | 禁用 `generate_mind_map,generate_fishbone_diagram` | 工具数降为 **25**，两个工具均已消失 |

未实测（需真实 OSS 凭据，请部署时按 §4.3 自检）：渲染服务完整构建、图片实际上传 OSS、
直链/预签名链接的实际可访问性与过期表现。