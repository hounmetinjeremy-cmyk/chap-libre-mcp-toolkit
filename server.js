import express from "express";
import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Octokit } from "@octokit/rest";

const PORT = process.env.PORT || 8080;
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_OUTPUT_CHARS = 20000;
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "30000", 10);

if (!AUTH_TOKEN) {
  console.warn(
    "[WARN] MCP_AUTH_TOKEN n'est pas défini — l'outil terminal sera accessible par quiconque trouve cette URL. " +
      "Définis MCP_AUTH_TOKEN sur Render avant toute utilisation sérieuse."
  );
}

const octokit = GITHUB_TOKEN ? new Octokit({ auth: GITHUB_TOKEN }) : null;

function requireGithub() {
  if (!octokit) {
    throw new Error("GITHUB_TOKEN n'est pas configuré sur ce serveur.");
  }
  return octokit;
}

function buildServer() {
  const server = new McpServer({ name: "chap-libre-toolkit", version: "1.0.0" });

  // ---------------- Terminal ----------------
  server.tool(
    "run_command",
    "Exécute une commande shell sur le serveur hébergeant cet outil MCP et retourne stdout/stderr. " +
      "À utiliser avec prudence : la commande s'exécute avec les permissions du process serveur.",
    {
      command: z.string().describe("Commande shell à exécuter"),
      cwd: z.string().optional().describe("Répertoire de travail (par défaut /app)"),
    },
    async ({ command, cwd }) => {
      return new Promise((resolve) => {
        exec(
          command,
          { cwd: cwd || process.cwd(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout, stderr) => {
            const out = (stdout || "").slice(0, MAX_OUTPUT_CHARS);
            const err = (stderr || "").slice(0, MAX_OUTPUT_CHARS);
            const text = [
              `$ ${command}`,
              out ? `--- stdout ---\n${out}` : null,
              err ? `--- stderr ---\n${err}` : null,
              error ? `--- error ---\n${error.message}` : null,
            ]
              .filter(Boolean)
              .join("\n\n");
            resolve({
              content: [{ type: "text", text: text || "(aucune sortie)" }],
              isError: Boolean(error),
            });
          }
        );
      });
    }
  );

  // ---------------- GitHub ----------------
  server.tool(
    "github_list_repos",
    "Liste les dépôts du compte GitHub authentifié.",
    { per_page: z.number().min(1).max(100).optional() },
    async ({ per_page }) => {
      const gh = requireGithub();
      const { data } = await gh.repos.listForAuthenticatedUser({ per_page: per_page || 30, sort: "updated" });
      const text = data.map((r) => `${r.full_name} — ${r.private ? "privé" : "public"} — ${r.html_url}`).join("\n");
      return { content: [{ type: "text", text: text || "Aucun dépôt trouvé." }] };
    }
  );

  server.tool(
    "github_get_file",
    "Lit le contenu d'un fichier dans un dépôt GitHub.",
    {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      ref: z.string().optional(),
    },
    async ({ owner, repo, path, ref }) => {
      const gh = requireGithub();
      const { data } = await gh.repos.getContent({ owner, repo, path, ref });
      if (Array.isArray(data)) {
        return { content: [{ type: "text", text: data.map((d) => `${d.type}\t${d.path}`).join("\n") }] };
      }
      const content = Buffer.from(data.content, data.encoding).toString("utf-8");
      return { content: [{ type: "text", text: content }] };
    }
  );

  server.tool(
    "github_create_or_update_file",
    "Crée ou met à jour un fichier dans un dépôt GitHub (un seul fichier, un seul commit).",
    {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      branch: z.string().optional(),
    },
    async ({ owner, repo, path, content, message, branch }) => {
      const gh = requireGithub();
      let sha;
      try {
        const { data } = await gh.repos.getContent({ owner, repo, path, ref: branch });
        if (!Array.isArray(data)) sha = data.sha;
      } catch (e) {
        // le fichier n'existe pas encore, c'est normal
      }
      const { data } = await gh.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        branch,
        content: Buffer.from(content, "utf-8").toString("base64"),
        sha,
      });
      return { content: [{ type: "text", text: `Commité ${path} (${data.commit.sha})` }] };
    }
  );

  server.tool(
    "github_list_issues",
    "Liste les issues d'un dépôt GitHub.",
    {
      owner: z.string(),
      repo: z.string(),
      state: z.enum(["open", "closed", "all"]).optional(),
    },
    async ({ owner, repo, state }) => {
      const gh = requireGithub();
      const { data } = await gh.issues.listForRepo({ owner, repo, state: state || "open" });
      const text = data.map((i) => `#${i.number} ${i.title} (${i.state})`).join("\n");
      return { content: [{ type: "text", text: text || "Aucune issue trouvée." }] };
    }
  );

  server.tool(
    "github_create_issue",
    "Crée une nouvelle issue dans un dépôt GitHub.",
    {
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
    },
    async ({ owner, repo, title, body }) => {
      const gh = requireGithub();
      const { data } = await gh.issues.create({ owner, repo, title, body });
      return { content: [{ type: "text", text: `Issue créée #${data.number}: ${data.html_url}` }] };
    }
  );

  server.tool(
    "github_search_code",
    "Recherche du code sur GitHub.",
    { query: z.string() },
    async ({ query }) => {
      const gh = requireGithub();
      const { data } = await gh.search.code({ q: query });
      const text = data.items.map((i) => `${i.repository.full_name}: ${i.path}`).join("\n");
      return { content: [{ type: "text", text: text || "Aucun résultat." }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Auth par jeton Bearer (protège notamment l'outil terminal)
app.use((req, res, next) => {
  if (req.path === "/health") return next();
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
    const server = buildServer();
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
  console.log(`Serveur MCP (terminal + GitHub) à l'écoute sur le port ${PORT}`);
});
