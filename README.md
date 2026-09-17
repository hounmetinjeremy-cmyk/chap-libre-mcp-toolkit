# Chap Libre — MCP Toolkit (Terminal + GitHub)

Serveur MCP auto-hébergé exposant :
- `run_command` — exécute une commande shell sur le serveur (⚠️ protégé par jeton, voir ci-dessous)
- `github_list_repos`, `github_get_file`, `github_create_or_update_file`, `github_list_issues`, `github_create_issue`, `github_search_code`

## Variables d'environnement (à définir sur Render)

| Variable | Obligatoire | Description |
|---|---|---|
| `MCP_AUTH_TOKEN` | Fortement recommandé | Jeton Bearer que LibreChat devra envoyer dans l'en-tête `Authorization`. Sans lui, n'importe qui connaissant l'URL peut exécuter des commandes sur ton serveur. |
| `GITHUB_TOKEN` | Pour les outils GitHub | Personal Access Token GitHub (fine-grained), avec les scopes `repo` et `issues`. |
| `COMMAND_TIMEOUT_MS` | Optionnel | Timeout des commandes shell (défaut : 30000 ms). |
| `PORT` | Géré par Render | Render la définit automatiquement. |

## Déploiement sur Render

1. Ce dépôt contient déjà un `Dockerfile` — Render le détecte automatiquement.
2. Crée un service Web sur Render pointant vers ce dépôt, runtime Docker.
3. Ajoute les variables d'environnement ci-dessus dans les Settings du service.
4. Une fois déployé, ton URL MCP sera : `https://<ton-service>.onrender.com/mcp`

## Connexion dans LibreChat

1. Ouvre le panneau **MCP Settings** (barre latérale droite).
2. Clique sur **+**.
3. Renseigne :
   - **Nom** : `chap-libre-toolkit` (ou ce que tu veux)
   - **URL** : `https://<ton-service>.onrender.com/mcp`
   - **Type de transport** : Streamable HTTP
   - **Authentification** : Bearer token → colle la valeur de `MCP_AUTH_TOKEN`
4. **Create**.

## Sécurité

L'outil `run_command` donne un accès shell complet au conteneur qui héberge ce serveur.
Ne déploie jamais ce service sans `MCP_AUTH_TOKEN` défini, et ne partage ce jeton avec personne.
