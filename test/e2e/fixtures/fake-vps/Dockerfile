# Fake VPS target for Tier 3 e2e tests.
#
# Ships enough of what a groundflare-bootstrapped Ubuntu 24.04 VPS looks
# like that stages 0-6 of runBootstrap complete end-to-end without any
# external cloud. Specifically:
#
#   - systemd as PID 1 (so `systemctl enable` is real)
#   - openssh-server listening on 22
#   - `groundflare` user with passwordless sudo (mirrors cloud-init)
#   - a shim `cloud-init` binary that satisfies `cloud-init status --wait`
#     (real cloud-init doesn't run inside Docker — the bootstrap doesn't
#      care as long as the command returns 0)
#   - Caddy pre-installed so stage 06 can `systemctl enable caddy`
#   - workerd linux-64 binary at /usr/local/bin/workerd so stage 05's
#     isComplete() check passes (the real upload is still exercised when
#     the binary is re-pushed, but a fresh run finds it already present)
#
# Run with --privileged so systemd can manage cgroups. Fine for tests;
# not something we'd do in production (and production doesn't need to).

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Auto-populated by BuildKit: "amd64" on x86_64 hosts, "arm64" on ARM64.
ARG TARGETARCH

# Base image: systemd + sshd + sudo + curl + Caddy (Ubuntu universe).
RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
      openssh-server \
      sudo \
      curl ca-certificates \
      iproute2 \
      less \
      caddy \
 && rm -rf /var/lib/apt/lists/*

# sshd config: key-only auth, no root login.
RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && sed -i 's/^#*PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#*PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && systemctl enable ssh

# Create the `groundflare` user matching what cloud-init emits in prod.
RUN useradd -m -s /bin/bash groundflare \
 && echo 'groundflare ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/groundflare \
 && chmod 440 /etc/sudoers.d/groundflare \
 && install -d -m 0700 -o groundflare -g groundflare /home/groundflare/.ssh

# cloud-init shim: bootstrap only calls `cloud-init status --wait`. Returning
# "done" lets stage 04 pass without dragging the real cloud-init package in
# (which is 200+ MB and tries to do a bunch of DHCP/hostname stuff that
# doesn't fit a container).
RUN printf '#!/bin/sh\nif [ "$1" = "status" ]; then echo done; exit 0; fi\nexec /bin/true\n' \
      > /usr/bin/cloud-init \
 && chmod 0755 /usr/bin/cloud-init

# Ensure /etc/caddy exists even though we let stage 06 write the Caddyfile.
RUN install -d -m 0755 /etc/caddy

# Ubuntu 24.04 ships Caddy 2.6.2 which lacks the `persist_config` global
# option groundflare's generator emits. Overwrite the binary with a
# current release so the Caddyfile validates. We keep apt's systemd unit
# + caddy user — only the binary changes.
ARG CADDY_VERSION=2.8.4
RUN case "${TARGETARCH}" in \
      amd64) CADDY_ARCH=amd64 ;; \
      arm64) CADDY_ARCH=arm64 ;; \
      *)     echo "unsupported arch ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz" \
      -o /tmp/caddy.tgz \
 && tar -xzf /tmp/caddy.tgz -C /tmp caddy \
 && install -m 0755 /tmp/caddy /usr/bin/caddy \
 && rm -f /tmp/caddy.tgz /tmp/caddy \
 && /usr/bin/caddy version

# State layout that stage 05 would otherwise create. Test can still assert
# on it — the install-runtime stage walks these paths in isComplete().
# If a stage isn't idempotent yet, the install would fail; keeping the
# state dir empty means stage 05 still does its thing.

# workerd — pin to the same version as the host's workerd package.
# Cloudflare's npm naming: amd64 → `linux-64`, arm64 → `linux-arm64`.
ARG WORKERD_VERSION=1.20260414.1
RUN case "${TARGETARCH}" in \
      amd64) WORKERD_ARCH=linux-64 ;; \
      arm64) WORKERD_ARCH=linux-arm64 ;; \
      *)     echo "unsupported arch ${TARGETARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL "https://registry.npmjs.org/@cloudflare/workerd-${WORKERD_ARCH}/-/workerd-${WORKERD_ARCH}-${WORKERD_VERSION}.tgz" \
      -o /tmp/workerd.tgz \
 && tar -xzf /tmp/workerd.tgz -C /tmp \
 && install -m 0755 /tmp/package/bin/workerd /usr/local/bin/workerd \
 && rm -rf /tmp/workerd.tgz /tmp/package \
 && /usr/local/bin/workerd --version >/dev/null

EXPOSE 22

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
