import "dotenv/config";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import { spawn } from "node:child_process";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const PUBLIC_BASE_URL = requireEnv("PUBLIC_BASE_URL");
const STATIC_BEARER_TOKEN = requireEnv("STATIC_BEARER_TOKEN");
const PORT = parseInt(process.env.PORT || "8080", 10);
const MCP_REMOTE_PORT = parseInt(process.env.MCP_REMOTE_PORT || "9696", 10);
const ROVO_MCP_URL =
  process.env.ROVO_MCP_URL || "https://mcp.atlassian.com/v1/mcp";

const app = express();

/* ================================
   VERSION + HEALTH (ALWAYS OPEN)
================================ */

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/__version", (_req, res) => {
  res.json({
    ok: true,
    build: process.env.RENDER_GIT_COMMIT || "local-dev",
    mcp_upstream: ROVO_MCP_URL,
    note: "If you see this, the latest server.js is running.",
  });
});

/* ================================
   OPEN PATHS (OAuth callbacks)
================================ */

const OPEN_PATHS_EXACT = new Set([
  "/oauth/callback",
  "/auth/callback",
  "/callback",
]);

function isOpenPath(path) {
  if (OPEN_PATHS_EXACT.has(path)) return true;
  if (path.startsWith("/oauth/")) return true;
  if (path.startsWith("/auth/")) return true;
  if (path === "/healthz") return true;
  if (path === "/__version") return true;
  return false;
}

/* ================================
   STATIC BEARER AUTH GATE
================================ */

app.use((req, res, next) => {
  if (isOpenPath(req.path)) return next();

  const auth = req.headers.authorization || "";
  const expected = `Bearer ${STATIC_BEARER_TOKEN}`;

  if (auth !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

/* ================================
   MCP-REMOTE LOGIN LINK CAPTURE
================================ */

let latestLoginUrl = null;
let latestLoginUrlSeenAt = null;

function extractUrls(text) {
  const re = /https?:\/\/[^\s"')\]]+/g;
  return text.match(re) || [];
}

function startMcpRemote() {
  const publicHost = new URL(PUBLIC_BASE_URL).host;

  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "mcp-remote",
    ROVO_MCP_URL,
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
}

startMcpRemote();

/* ================================
   LOGIN LINK ENDPOINT
================================ */

app.get("/login-link", (_req, res) => {
  if (!latestLoginUrl) {
    return res.status(404).json({
      error: "No login link captured yet.",
      hint: "Call /mcp once (with bearer token) to trigger OAuth, then retry.",
    });
  }

  res.json({
    login_url: latestLoginUrl,
    seen_at: latestLoginUrlSeenAt,
  });
});

/* ================================
   MCP ROUTE MARKER (DEBUG)
================================ */

app.all("/mcp", (req, res, next) => {
  res.setHeader("x-gateway-mcp-route", "hit");
  next();
});

/* ================================
   MCP PROXY
================================ */

app.use(
  "/mcp",
  createProxyMiddleware({
    target: `http://127.0.0.1:${MCP_REMOTE_PORT}`,
    changeOrigin: true,
    ws: true,
    logLevel: "warn",
  }),
);

/* ================================
   START SERVER
================================ */

app.listen(PORT, () => {
  console.log(`Rovo MCP Gateway running on port ${PORT}`);
  console.log(`Public URL: ${PUBLIC_BASE_URL}`);
  console.log(`Upstream Rovo MCP: ${ROVO_MCP_URL}`);
});
