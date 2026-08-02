FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential dpkg-dev p7zip-full python3 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json upstream.json ./
COPY src ./src
COPY desktop/package.json desktop/package-lock.json desktop/launcher.cjs ./desktop/
COPY desktop/packaging ./desktop/packaging
RUN npm ci

ENTRYPOINT ["npm", "run", "port", "--", "build", "--dmg", "/input/ChatGPT.dmg", "--output", "/output", "--work", "/work"]
