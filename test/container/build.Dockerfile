FROM node:22-bookworm-slim AS node

FROM rust:1.87-bookworm
COPY --from=node /usr/local/ /usr/local/

ARG NFPM_VERSION=v2.47.0
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates curl flatpak flatpak-builder \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 \
    libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
    p7zip-full python3 squashfs-tools tar zstd \
  && curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/${NFPM_VERSION}/nfpm_${NFPM_VERSION#v}_amd64.deb" -o /tmp/nfpm.deb \
  && dpkg -i /tmp/nfpm.deb \
  && rm /tmp/nfpm.deb \
  && rm -rf /var/lib/apt/lists/*

RUN flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo \
  && set -eu \
  && for flatpak_ref in \
      runtime/org.freedesktop.Platform/x86_64/24.08 \
      runtime/org.freedesktop.Sdk/x86_64/24.08 \
      app/org.electronjs.Electron2.BaseApp/x86_64/24.08; do \
    flatpak_attempt=1; \
    until flatpak install --user --noninteractive --assumeyes --no-deps --no-related \
      --no-static-deltas --or-update --arch=x86_64 flathub "$flatpak_ref"; do \
      if [ "$flatpak_attempt" -ge 5 ]; then exit 1; fi; \
      flatpak_attempt=$((flatpak_attempt + 1)); \
    done; \
  done

RUN apt-get update && apt-get install -y --no-install-recommends imagemagick \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json upstream.json ./
COPY src ./src
COPY desktop/package.json desktop/package-lock.json desktop/launcher.cjs ./desktop/
COPY desktop/packaging ./desktop/packaging
COPY desktop/linux-runtime ./desktop/linux-runtime
COPY desktop/linux-plugins ./desktop/linux-plugins
COPY desktop/linux-desktop-bridge ./desktop/linux-desktop-bridge
COPY desktop/runtime/package.json desktop/runtime/package-lock.json ./desktop/runtime/
COPY packaging ./packaging
RUN npm ci

ENTRYPOINT ["npm", "run", "port", "--", "build", "--archive", "/input/ChatGPT.zip", "--output", "/output", "--work", "/work"]
