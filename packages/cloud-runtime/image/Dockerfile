# Example only: build linux/amd64, then qualify it before publishing to VCR.
# Digests were read from the official Docker Hub registry metadata on 2026-10-30.
FROM composer:2.8.12@sha256:5248900ab8b5f7f880c2d62180e40960cd87f60149ec9a1abfd62ac72a02577c AS composer
FROM docker:28.5.1-dind@sha256:ea9d20492ca1caaaba78e68453433895d256173c79281756e88b745647fcbcfd AS docker_tools
FROM node:24.22.1-bookworm@sha256:d862bb5d082c5ae0210ac07e8c0344cb8cf7bef6d78e9b8c50c179da923108ea AS tools

# The dated Debian snapshot also fixes apt resolution for this example image.
ARG DEBIAN_SNAPSHOT=20261029T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources \
    && printf 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian/%s bookworm-updates main\ndeb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      bash ca-certificates curl git sudo openssh-client unzip zip \
      php8.2-cli php8.2-curl php8.2-mbstring php8.2-xml php8.2-zip php8.2-pgsql \
      iptables iproute2 pigz xz-utils procps kmod util-linux libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=composer /usr/bin/composer /usr/local/bin/composer
# Static engine binaries, with compose from the same pinned official image.
# Do not copy Docker's entrypoint: it enables a TCP daemon listener by default.
COPY --from=docker_tools /usr/local/bin/docker /usr/local/bin/dockerd /usr/local/bin/containerd /usr/local/bin/containerd-shim-runc-v2 /usr/local/bin/ctr /usr/local/bin/runc /usr/local/bin/docker-init /usr/local/bin/docker-proxy /usr/local/bin/
COPY --from=docker_tools /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose

RUN npm install --global --ignore-scripts @openai/codex@0.166.0 pnpm@12.16.1 \
    && npm cache clean --force \
    && printf 'node ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/falcondeck-worker \
    && chmod 0440 /etc/sudoers.d/falcondeck-worker \
    && groupadd --system falcondeck-docker \
    && usermod -a -G falcondeck-docker node \
    && install -d -o node -g node -m 0700 /workspace /opt/falcondeck-cloud \
    && node --version && codex --version && pnpm --version && php --version \
    && composer --version && docker --version && docker compose version

COPY --chmod=0755 start-test-docker.sh /usr/local/bin/falcondeck-start-test-docker
COPY compose.test.yml /opt/falcondeck-cloud/compose.test.yml

# The adapter supplies a verified daemon binary and task-local auth/state at boot.
# This image contains no FalconDeck identity, native login, connector or model key.
USER node
WORKDIR /workspace
ENTRYPOINT []
CMD ["bash"]

# CI supplies one locally built Linux executable through this narrow context.
# It is intentionally outside the default runtime target, so an example build
# needs no daemon artifact. No credential/config files are copied.
FROM tools AS with-daemon
COPY --chmod=0755 daemon/falcondeck-daemon /usr/local/bin/falcondeck-daemon
RUN /usr/local/bin/falcondeck-daemon --version

# Keep the ordinary example build usable before a daemon has been compiled.
FROM tools AS runtime
