# MCP Server Chart — Docker 部署 streamable 模式 & 自定义图片地址分析

## 项目结构概览

`@antv/mcp-server-chart` 是一个 MCP (Model Context Protocol) 图表生成服务，支持三种传输模式：`stdio`、`sse`、`streamable`。

---

## 一、Docker 部署 streamableHttp 模式

项目提供了**两套** Docker 部署方式：

### 方式 A：根目录 docker-compose.yaml（单服务）

`docker-compose.yaml` 默认使用 **SSE** 传输，通过 `command` 覆盖即可切换为 streamable：

```yaml
services:
  mcp-server-chart:
    build:
      context: .
      dockerfile: Dockerfile
    # 默认是 SSE，要改为 streamable 只需修改 command：
    command: ["node", "build/index.js", "--transport", "streamable", "--port", "1122", "--host", "0.0.0.0"]
    ports:
      - "1122:1122"
```

### 方式 B：docker/docker-compose.yml（双服务并行）

`docker/docker-compose.yml` 同时启动 **SSE（1123 端口）** 和 **streamable（1122 端口）** 两个服务：

```yaml
name: mcp-server-chart
services:
  sse:
    build:
      context: ./sse        # docker/sse/Dockerfile
    ports:
      - "1123:1123"

  streamable:
    build:
      context: ./streamable # docker/streamable/Dockerfile
    ports:
      - "1122:1122"
```

对应的 Dockerfile 使用全局安装方式：

```dockerfile
# docker/streamable/Dockerfile
FROM node:lts
WORKDIR /app
RUN npm install -g @antv/mcp-server-chart
CMD ["mcp-server-chart", "--transport", "streamable", "--port", "1122"]
```

### 方式 C：docker-compose.test.yaml（测试用）

`docker-compose.test.yaml` 直接从本地构建，使用 streamable 传输，并设置了 `VIS_REQUEST_SERVER` 环境变量：

```yaml
services:
  mcp-server-chart:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      - VIS_REQUEST_SERVER=http://localhost:3000/render
    command: ["node", "build/index.js", "--transport", "streamable", "--port", "1122", "--host", "0.0.0.0"]
    ports:
      - "1122:1122"
```

### streamable 传输的实现细节

核心实现在 `src/services/streamable.ts`：

- 使用 Express 启动 HTTP 服务
- 监听 `POST /mcp` 端点（可通过 `--endpoint` / `-e` 自定义）
- 每个请求创建独立的 `StreamableHTTPServerTransport` 实例（stateless 模式，避免 JSON-RPC request ID 冲突）
- 支持 CORS，暴露 `Mcp-Session-Id` 响应头
- 启动参数：`--transport streamable --port 1122 --host 0.0.0.0 --endpoint /mcp`

入口参数解析在 `src/index.ts`：

| 参数 | 简写 | 默认值 | 说明 |
|------|------|--------|------|
| `--transport` | `-t` | `stdio` | `stdio` / `sse` / `streamable` |
| `--host` | `-h` | `localhost` | 监听地址 |
| `--port` | `-p` | `1122` | 监听端口 |
| `--endpoint` | `-e` | `/mcp` (streamable) | HTTP 端点路径 |

---

## 二、自定义图片地址（VIS_REQUEST_SERVER）

### 作用

`VIS_REQUEST_SERVER` 是一个环境变量，用于指定**图表渲染服务**的地址。MCP 服务将图表配置（类型 + 数据 + 参数）POST 到这个地址，渲染服务返回图片 URL。

### 数据流

```
MCP Server (streamable)  ──POST 图表配置──▶  VIS_REQUEST_SERVER
                                              │
              ◀────────── 返回图片 URL ───────┘
                                              │
              ──返回给 MCP Client ────────────▶  (text 类型，内容是图片 URL)
```

### 默认值

```typescript
// src/utils/env.ts
export function getVisRequestServer() {
  return (
    process.env.VIS_REQUEST_SERVER ||
    "https://antv-studio.alipay.com/api/gpt-vis"  // AntV 官方默认渲染服务
  );
}
```

### 在代码中的使用

`src/utils/generate.ts` 中的 `generateChartUrl()` 和 `generateMap()` 函数会 POST 请求到该地址：

```typescript
// generateChartUrl 示例
const url = getVisRequestServer();

const response = await httpClient.post(url, {
  type,           // 图表类型，如 "line", "bar"
  ...options,     // 图表数据与配置
  source: "mcp-server-chart",
});

// 返回的 resultObj 就是图片 URL
return resultObj;
```

### 如何设置自定义地址

**方式 1：Docker Compose 中设置环境变量**

```yaml
services:
  mcp-server-chart:
    environment:
      - VIS_REQUEST_SERVER=http://your-private-server:3000/render
```

**方式 2：docker run 命令行**

```bash
docker run -e VIS_REQUEST_SERVER=http://your-private-server:3000/render -p 1122:1122 mcp-server-chart:stable
```

**方式 3：直接运行（非 Docker）**

```bash
VIS_REQUEST_SERVER=http://localhost:3000/render npx @antv/mcp-server-chart --transport streamable --port 1122
```

### 自定义渲染服务的部署建议

项目注释中提到可以使用 AntV 的 [GPT-Vis-SSR](https://github.com/antvis/gpt-vis-ssr) 项目在私有环境部署渲染服务。该服务接收图表配置并返回渲染好的图片 URL，部署后只需将地址通过 `VIS_REQUEST_SERVER` 传入即可。

---

## 总结

| 目标 | 操作 |
|------|------|
| 部署 streamable 模式 | 使用 `docker/docker-compose.yml` 中的 `streamable` 服务，或修改 `docker-compose.yaml` 的 `command` |
| 修改默认端口/端点 | 在 `command` 中传入 `--port`、`--endpoint`、`--host` |
| 自定义图片渲染地址 | 设置环境变量 `VIS_REQUEST_SERVER=http://your-server:port/render` |
| 使用私有渲染服务 | 部署 GPT-Vis-SSR 并获得 URL，填入 `VIS_REQUEST_SERVER` |