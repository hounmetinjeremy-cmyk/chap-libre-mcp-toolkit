import express from "express";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Fallback token global si besoin

// OAuth GitHub Config
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const BASE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

const MAX_OUTPUT_CHARS = 20000;
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "30000", 10);

// Stockage en mémoire des tokens par session utilisateur OAuth { sessionId: token }
const userTokens = {};

function getOctokit(req) {
  // 1. Chercher un token OAuth lié à la session
  const sessionId = req?.headers?.["mcp-session-id"];
  if (sessionId && userTokens[sessionId]) {
    return new Octokit({ auth: userTokens[sessionId] });
  }
  // 2. Fallback sur le token global configuré sur Render
  if (GITHUB_TOKEN) {
    return new Octokit({ auth: GITHUB_TOKEN });
  }
  throw new Error("Non authentifié via GitHub. Veuillez vous connecter sur /login pour autoriser l'application.");
}

function buildServer(req) {
  const server = new McpServer({ name: "chap-libre-toolkit", version: "2.1.0" });

  // --- TERMINAL & SYSTEM ---
  server.tool(
    "run_command",
    "Exécute une commande shell sur le serveur.",
    {
      command: z.string().describe("Commande shell à exécuter"),
      cwd: z.string().optional().describe("Répertoire de travail"),
    },
    async ({ command, cwd }) => {
      return new Promise((resolve) => {
        exec(
          command,
          { cwd: cwd || process.cwd(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = (stdout || "").slice(0, MAX_OUTPUT_CHARS);
            const err = (stderr || "").slice(0, MAX_OUTPUT_CHARS);
            const text = [`$ ${command}`, out ? `--- stdout ---\n${out}` : null, err ? `--- stderr ---\n${err}` : null].filter(Boolean).join("\n\n");
            resolve({ content: [{ type: "text", text: text || "(aucune sortie)" }], isError: Boolean(error) });
          }
        );
      });
    }
  );

  // --- LOCAL FILE SYSTEM & HTTP ---
  server.tool("fs_list_directory", "Liste un répertoire local.", { dirPath: z.string() }, async ({ dirPath }) => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return { content: [{ type: "text", text: entries.map(e => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`).join("\n") }] };
  });

  server.tool("fs_read_file", "Lit un fichier local.", { filePath: z.string() }, async ({ filePath }) => {
    const content = await fs.readFile(filePath, "utf-8");
    return { content: [{ type: "text", text: content }] };
  });

  server.tool("fs_write_file", "Écrit un fichier local.", { filePath: z.string(), content: z.string() }, async ({ filePath, content }) => {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf-8");
    return { content: [{ type: "text", text: `Écrit : ${filePath}` }] };
  });

  server.tool("http_request", "Requête HTTP externe.", { url: z.string(), method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"), headers: z.record(z.string()).optional(), body: z.string().optional() }, async ({ url, method, headers, body }) => {
    const res = await fetch(url, { method, headers: headers || {}, body: body && ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? body : undefined });
    const text = await res.text();
    return { content: [{ type: "text", text: `Status: ${res.status}\n\n${text}` }], isError: !res.ok };
  });

  // --- GITHUB TOOLS (Dynamiques selon l'utilisateur connecté) ---
  server.tool("github_list_repos", "Liste les dépôts GitHub de l'utilisateur connecté.", { per_page: z.number().optional() }, async ({ per_page }) => {
    const gh = getOctokit(req);
    const { data } = await gh.repos.listForAuthenticatedUser({ per_page: per_page || 30, sort: "updated" });
    const text = data.map(r => `${r.full_name} ── ${r.private ? "privé" : "public"} ── ${r.html_url}`).join("\n");
    return { content: [{ type: "text", text: text || "Aucun dépôt." }] };
  });

  server.tool("github_get_file", "Lit un fichier GitHub.", { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional() }, async ({ owner, repo, path, ref }) => {
    const gh = getOctokit(req);
    const { data } = await gh.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return { content: [{ type: "text", text: data.map(d => `${d.type}\t${d.path}`).join("\n") }] };
    return { content: [{ type: "text", text: Buffer.from(data.content, data.encoding).toString("utf-8") }] };
  });

  server.tool("github_create_or_update_file", "Crée ou met à jour un fichier GitHub.", { owner: z.string(), repo: z.string(), path: z.string(), content: z.string(), message: z.string(), branch: z.string().optional() }, async ({ owner, repo, path, content, message, branch }) => {
    const gh = getOctokit(req);
    let sha;
    try {
      const { data } = await gh.repos.getContent({ owner, repo, path, ref: branch });
      if (!Array.isArray(data)) sha = data.sha;
    } catch (e) {}
    const { data } = await gh.repos.createOrUpdateFileContents({ owner, repo, path, message, branch, content: Buffer.from(content, "utf-8").toString("base64"), sha });
    return { content: [{ type: "text", text: `Committé ${path} (${data.commit.sha})` }] };
  });

  server.tool("github_list_issues", "Liste les issues.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional() }, async ({ owner, repo, state }) => {
    const gh = getOctokit(req);
    const { data } = await gh.issues.listForRepo({ owner, repo, state: state || "open" });
    return { content: [{ type: "text", text: data.map(i => `#${i.number} ${i.title} (${i.state})`).join("\n") || "Aucune issue." }] };
  });

  server.tool("github_create_issue", "Crée une issue.", { owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional() }, async ({ owner, repo, title, body }) => {
    const gh = getOctokit(req);
    const { data } = await gh.issues.create({ owner, repo, title, body });
    return { content: [{ type: "text", text: `Issue créée #${data.number}: ${data.html_url}` }] };
  });

  server.tool("github_add_issue_comment", "Commente une issue/PR.", { owner: z.string(), repo: z.string(), issue_number: z.number(), body: z.string() }, async ({ owner, repo, issue_number, body }) => {
    const gh = getOctokit(req);
    const { data } = await gh.issues.createComment({ owner, repo, issue_number, body });
    return { content: [{ type: "text", text: `Commentaire ajouté : ${data.html_url}` }] };
  });

  server.tool("github_list_pull_requests", "Liste les PRs.", { owner: z.string(), repo: z.string(), state: z.enum(["open", "closed", "all"]).optional() }, async ({ owner, repo, state }) => {
    const gh = getOctokit(req);
    const { data } = await gh.pulls.list({ owner, repo, state: state || "open" });
    return { content: [{ type: "text", text: data.map(pr => `PR #${pr.number} - ${pr.title} (${pr.state})`).join("\n") || "Aucune PR." }] };
  });

  server.tool("github_get_pull_request", "Détails d'une PR.", { owner: z.string(), repo: z.string(), pull_number: z.number() }, async ({ owner, repo, pull_number }) => {
    const gh = getOctokit(req);
    const { data } = await gh.pulls.get({ owner, repo, pull_number });
    return { content: [{ type: "text", text: `PR #${data.number}: ${data.title}\nStatut: ${data.state}\nURL: ${data.html_url}\n\n${data.body || ""}` }] };
  });

  server.tool("github_create_pull_request", "Crée une PR.", { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional() }, async ({ owner, repo, title, head, base, body }) => {
    const gh = getOctokit(req);
    const { data } = await gh.pulls.create({ owner, repo, title, head, base, body });
    return { content: [{ type: "text", text: `PR #${data.number} créée : ${data.html_url}` }] };
  });

  server.tool("github_merge_pull_request", "Merge une PR.", { owner: z.string(), repo: z.string(), pull_number: z.number(), commit_title: z.string().optional() }, async ({ owner, repo, pull_number, commit_title }) => {
    const gh = getOctokit(req);
    const { data } = await gh.pulls.merge({ owner, repo, pull_number, commit_title });
    return { content: [{ type: "text", text: `PR #${pull_number} mergée (${data.sha})` }] };
  });

  server.tool("github_list_branches", "Liste les branches.", { owner: z.string(), repo: z.string() }, async ({ owner, repo }) => {
    const gh = getOctokit(req);
    const { data } = await gh.repos.listBranches({ owner, repo });
    return { content: [{ type: "text", text: data.map(b => b.name).join("\n") }] };
  });

  server.tool("github_search_code", "Recherche du code.", { query: z.string() }, async ({ query }) => {
    const gh = getOctokit(req);
    const { data } = await gh.search.code({ q: query });
    return { content: [{ type: "text", text: data.items.map(i => `${i.repository.full_name}: ${i.path}`).join("\n") || "Aucun résultat." }] };
  });

  return server;
}

const app = express();
app.use(express.json());

// Page de connexion OAuth
app.get("/login", (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.send("<h1>Erreur</h1><p>GITHUB_CLIENT_ID n'est pas configuré sur le serveur Render.</p>");
  }
  const redirectUri = `${BASE_URL}/auth/callback`;
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=repo,issues`;
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Connexion à Chap Libre MCP Toolkit</h2>
        <p>Cliquez ci-dessous pour autoriser l'accès à votre compte GitHub en un clic :</p>
        <a href="${githubAuthUrl}" style="background: #24292e; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Se connecter avec GitHub</a>
      </body>
    </html>
  `);
});

// Callback OAuth GitHub
app.get("/auth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Code d'autorisation manquant.");

  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "json" },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    if (!accessToken) {
      return res.status(400).send(`Erreur GitHub OAuth: ${JSON.stringify(tokenData)}`);
    }

    // Générer un identifiant de session unique pour l'utilisateur connecté
    const userSessionId = randomUUID();
    userTokens[userSessionId] = accessToken;

    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px; color: green;">
          <h2>Connexion réussie ! 🎉</h2>
          <p>Votre compte GitHub a été autorisé avec succès.</p>
          <p>Votre ID de session temporaire : <b>${userSessionId}</b></p>
          <p>Vous pouvez fermer cette fenêtre et utiliser votre outil MCP.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send(`Erreur serveur : ${err.message}`);
  }
});

// Middleware d'authentification Bearer pour l'API MCP
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/login" || req.path === "/auth/callback") return next();
  if (!AUTH_TOKEN) return next();
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

const transports = {};

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = buildServer(req);
    await server.connect(transport);
  } else {
    return res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: no valid session" },
      id: null,
    });
  }

  await transport.handleRequest(req, res, req.body);
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports[sessionId]) {
    return res.status(400).send("Invalid or missing session ID");
  }
  await transports[sessionId].handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`Serveur MCP OAuth prêt sur le port ${PORT}`);
});
