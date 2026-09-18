// Garde de sécurité chargée avant server.js (node --import ./guard.mjs server.js).
// - /authorize exige de saisir MCP_AUTH_TOKEN une fois dans le navigateur
// - /token refuse les refresh_token qui n'ont pas été émis par ce serveur
// - /mcp renvoie un 401 avec l'en-tête WWW-Authenticate (détection OAuth automatique)
import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

const TOKEN = process.env.MCP_AUTH_TOKEN;

if (TOKEN) {
  const same = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const sign = (exp) => createHmac("sha256", TOKEN).update(`authorize:${exp}`).digest("hex");
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const hasSession = (req) => {
    const m = /(?:^|;\s*)mcp_ok=(\d+)\.([0-9a-f]+)/.exec(req.headers.cookie || "");
    return Boolean(m) && Number(m[1]) > Date.now() && same(m[2], sign(m[1]));
  };

  const readBody = (req, limit = 16384) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error("trop volumineux"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const parseBody = (req, raw) => {
    if ((req.headers["content-type"] || "").includes("application/json")) {
      try {
        return JSON.parse(raw || "{}");
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(raw));
  };

  const send = (res, status, type, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
    res.end(body);
  };

  const loginPage = (res, q, error) =>
    send(
      res,
      error ? 401 : 200,
      "text/html; charset=utf-8",
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:0 16px;text-align:center">
<h2>Chap Libre MCP Toolkit</h2>
<p>Saisis ton jeton d'accès (MCP_AUTH_TOKEN) pour autoriser cette connexion.</p>
${error ? `<p style="color:#b00020">${esc(error)}</p>` : ""}
<form method="POST" action="/authorize-login">
<input type="hidden" name="q" value="${esc(q || "")}">
<input type="password" name="password" autofocus required style="width:100%;padding:12px;font-size:16px;box-sizing:border-box">
<button type="submit" style="margin-top:16px;background:#24292e;color:#fff;padding:12px 24px;border:none;border-radius:6px;font-weight:bold;font-size:16px">Autoriser</button>
</form></body></html>`
    );

  // Suivi des tentatives ratées (anti force brute) et des refresh_token émis
  const fails = new Map();
  const issued = new Set();
  const clientIp = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const blocked = (ip) => {
    const f = fails.get(ip);
    return Boolean(f) && f.until > Date.now() && f.n >= 8;
  };
  const recordFail = (ip) => {
    const f = fails.get(ip);
    const now = Date.now();
    fails.set(ip, !f || f.until < now ? { n: 1, until: now + 10 * 60 * 1000 } : { n: f.n + 1, until: f.until });
  };

  const baseUrl = (req) =>
    process.env.RENDER_EXTERNAL_URL || `https://${req.headers.host}`;

  async function guard(req, res, path, pass) {
    const method = req.method;

    if (path === "/authorize") {
      if (hasSession(req)) return pass();
      if (method === "GET") return loginPage(res, new URL(req.url, "http://x").search, "");
      return send(res, 401, "application/json", JSON.stringify({ error: "unauthorized" }));
    }

    if (path === "/authorize-login" && method === "POST") {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, "text/plain; charset=utf-8", "Trop de tentatives. Réessaie dans quelques minutes.");
      const b = parseBody(req, await readBody(req));
      const q = typeof b.q === "string" && /^\?[^\r\n]*$/.test(b.q) ? b.q : "";
      if (same(b.password || "", TOKEN)) {
        fails.delete(ip);
        const exp = Date.now() + 15 * 60 * 1000;
        res.writeHead(303, {
          Location: `/authorize${q}`,
          "Set-Cookie": `mcp_ok=${exp}.${sign(exp)}; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
          "Cache-Control": "no-store",
        });
        return res.end();
      }
      recordFail(ip);
      return loginPage(res, q, "Jeton incorrect.");
    }

    if (path === "/token" && method === "POST") {
      const body = parseBody(req, await readBody(req));
      req.body = body; // body-parser (Express) saute le parsing si req._body est vrai
      req._body = true;
      if (body.grant_type === "refresh_token" && !issued.has(body.refresh_token)) {
        return send(res, 400, "application/json", JSON.stringify({ error: "invalid_grant" }));
      }
      const end = res.end;
      res.end = function (chunk, ...rest) {
        try {
          if (res.statusCode === 200 && chunk) {
            const j = JSON.parse(chunk.toString());
            if (j.refresh_token) {
              if (issued.size > 1000) issued.clear();
              issued.add(j.refresh_token);
            }
          }
        } catch {}
        return end.call(this, chunk, ...rest);
      };
      return pass();
    }

    if (path === "/mcp") {
      const h = req.headers.authorization || "";
      if (!(h.startsWith("Bearer ") && same(h.slice(7), TOKEN))) {
        return send(res, 401, "application/json", JSON.stringify({ error: "Unauthorized" }), {
          "WWW-Authenticate": `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource"`,
        });
      }
    }

    return pass();
  }

  const origEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, res) {
    if (event !== "request") return origEmit.apply(this, arguments);
    const self = this;
    const args = arguments;
    let path;
    try {
      path = new URL(req.url, "http://x").pathname;
    } catch {
      path = req.url;
    }
    guard(req, res, path, () => origEmit.apply(self, args)).catch(() => {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    });
    return true;
  };
}
