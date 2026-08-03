FROM node:22-bookworm-slim

ARG NFPM_VERSION=v2.47.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl p7zip-full python3 \
  && curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/${NFPM_VERSION}/nfpm_${NFPM_VERSION#v}_amd64.deb" -o /tmp/nfpm.deb \
  && dpkg -i /tmp/nfpm.deb \
  && rm /tmp/nfpm.deb \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json upstream.json ./
COPY src ./src
COPY desktop/package.json desktop/package-lock.json desktop/launcher.cjs ./desktop/
COPY desktop/packaging ./desktop/packaging
COPY desktop/runtime/package.json desktop/runtime/package-lock.json ./desktop/runtime/
RUN npm ci

ENTRYPOINT ["npm", "run", "port", "--", "build", "--dmg", "/input/ChatGPT.dmg", "--output", "/output", "--work", "/work"]
