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

COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
