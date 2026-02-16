// server.js
// Rovo MCP Gateway: static Bearer auth (for your workflow tool) + mcp-remote (does Atlassian OAuth) + /login-link endpoint.
//
// Endpoints:
//   GET  /healthz                     (no auth)
//   GET  /login-link                  (requires static bearer) -> returns latest OAuth/login URL seen from mcp-remote output
//   ANY  /sse                         (requires static bearer) -> proxied to local mcp-remote (SSE)
//   ANY  /                            (requires static bearer) -> proxied to local mcp-remote (optional)
//
// Env vars:
//   PUBLIC_BASE_URL=https://rovo-gw.onrender.com
//   STATIC_BEARER_TOKEN=your-static-secret
//   PORT=8080
//   MCP_REMOTE_PORT=9696
//   ROVO_MCP_SSE_URL=https://mcp.atlassian.com/v1/sse

import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "node:child_process";
import "dotenv/config";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const PUBLIC_BASE_URL = requireEnv("PUBLIC_BASE_URL");
const STATIC_BEARER_TOKEN = requireEnv("STATIC_BEARER_TOKEN");
const PORT = parseInt(process.env.PORT || "8080", 10);
const MCP_REMOTE_PORT = parseInt(process.env.MCP_REMOTE_PORT || "9696", 10);
const ROVO_MCP_SSE_URL = requireEnv("ROVO_MCP_SSE_URL");

const app = express();

/**
 * IMPORTANT:
 * Atlassian OAuth redirects back to your service WITHOUT your static Authorization header,
 * so we must allow the OAuth callback routes through without STATIC_BEARER_TOKEN.
 *
 * If you see 401s during OAuth in Render logs, add the path being hit here.
 */
const OPEN_PATHS_EXACT = new Set([
  "/healthz",
  // common OAuth callback patterns:
  "/oauth/callback",
  "/auth/callback",
  "/callback",
]);

function isOpenPath(path) {
  if (OPEN_PATHS_EXACT.has(path)) return true;
  if (path.startsWith("/oauth/")) return true;
  if (path.startsWith("/auth/")) return true;
  return false;
}

// --- Static Bearer auth for everything except open paths ---
app.use((req, res, next) => {
  if (isOpenPath(req.path)) return next();

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${STATIC_BEARER_TOKEN}`;
  if (auth !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

/**
 * Capture latest login URL emitted by mcp-remote so you can fetch it via:
 *   GET /login-link  (with Authorization: Bearer <STATIC_BEARER_TOKEN>)
 */
let latestLoginUrl = null;
let latestLoginUrlSeenAt = null;

function extractUrls(text) {
  // capture http(s)://... until whitespace or common closing delimiters
  const re = /https?:\/\/[^\s"')\]]+/g;
  return text.match(re) || [];
}

function startMcpRemote() {
  const publicHost = new URL(PUBLIC_BASE_URL).host;

  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "mcp-remote",
    ROVO_MCP_SSE_URL,
    String(MCP_REMOTE_PORT),
    "--host",
    publicHost,
  ];

  const child = spawn(cmd, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const capture = (chunk) => {
    const urls = extractUrls(chunk);
    if (urls.length) {
      // keep the last URL observed
      latestLoginUrl = urls[urls.length - 1];
      latestLoginUrlSeenAt = new Date().toISOString();
    }
  };

  child.stdout.on("data", (chunk) => {
    process.stdout.write(chunk);
    capture(chunk);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    capture(chunk);
  });

  child.on("exit", (code) => {
    console.error(`mcp-remote exited with code ${code}`);
    process.exit(code ?? 1);
  });

  return child;
}

startMcpRemote();

app.get("/login-link", (_req, res) => {
  if (!latestLoginUrl) {
    return res.status(404).json({
      error: "No login link captured yet.",
      hint: "Trigger an MCP connection attempt (call /sse with your static bearer token), then retry /login-link.",
    });
  }
  res.json({
    login_url: latestLoginUrl,
    seen_at: latestLoginUrlSeenAt,
  });
});

// Proxy /sse to the local mcp-remote port (preserves SSE streaming)
app.use(
  "/sse",
  createProxyMiddleware({
    target: `http://127.0.0.1:${MCP_REMOTE_PORT}`,
    changeOrigin: true,
    ws: true,
    logLevel: "warn",
    onProxyRes(proxyRes) {
      proxyRes.headers["x-rovo-mcp-gateway"] = "1";
    },
  }),
);

// Optional: proxy everything else too (some MCP clients hit other paths)
app.use(
  "/",
  createProxyMiddleware({
    target: `http://127.0.0.1:${MCP_REMOTE_PORT}`,
    changeOrigin: true,
    ws: true,
    logLevel: "warn",
  }),
);

app.listen(PORT, () => {
  console.log(`Rovo MCP Gateway listening on :${PORT}`);
  console.log(`Public base URL: ${PUBLIC_BASE_URL}`);
  console.log(`Proxying /sse -> http://127.0.0.1:${MCP_REMOTE_PORT}`);
  console.log(`Get login link: GET /login-link (requires static bearer)`);
});
