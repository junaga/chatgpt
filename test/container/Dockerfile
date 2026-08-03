FROM node:22-bookworm-slim

ARG CODEX_NPM_SPEC=@openai/codex@0.146.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    dbus-x11 git libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgcc-s1 libglib2.0-0 libgtk-3-0 \
    libnspr4 libnss3 libpango-1.0-0 libstdc++6 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xauth xdg-utils xvfb xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "${CODEX_NPM_SPEC}"

WORKDIR /workspace
COPY desktop/package.json desktop/package-lock.json ./desktop/
RUN npm ci --prefix desktop --ignore-scripts
COPY desktop/tests ./desktop/tests
COPY test/container/run.sh /usr/local/bin/run-port-tests
RUN chmod 0755 /usr/local/bin/run-port-tests

ENTRYPOINT ["/usr/local/bin/run-port-tests"]
