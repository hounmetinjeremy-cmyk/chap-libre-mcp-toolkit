FROM node:20-alpine

# Outils système disponibles pour l'outil terminal (run_command)
RUN apk add --no-cache \
    bash \
    git \
    curl \
    wget \
    jq \
    python3 \
    py3-pip \
    openssh-client \
    ca-certificates \
    zip \
    unzip \
    tar \
    grep \
    sed \
    coreutils \
    ripgrep

WORKDIR /app

# --- Dépendances du toolkit (server.js + guard.mjs) ---
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts

# --- Dépendances runtime du serveur everything, isolées dans /app/everything/node_modules ---
COPY src/everything/package.json ./everything/package.json
RUN cd everything && npm install --omit=dev --no-audit --no-fund --ignore-scripts

# --- Code : dist pré-compilé de everything + toolkit patché ---
COPY server.js guard.mjs ./
COPY src/everything/dist ./everything/dist
COPY src/everything/docs ./everything/docs

ENV NODE_ENV=production
ENV EVERYTHING_PORT=3100
EXPOSE 8080

CMD ["node", "--import", "./guard.mjs", "server.js"]