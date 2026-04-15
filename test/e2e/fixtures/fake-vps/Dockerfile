# Fake VPS target for Tier 3 e2e tests.
#
# Mirrors what a fresh Ubuntu 24.04 VPS looks like right before
# groundflare's cloud-init stage runs:
#   - systemd as PID 1 (required for our tests to verify services)
#   - openssh-server listening on 22
#   - a `groundflare` user with passwordless sudo (matches cloud-init output)
#   - no workerd or caddy pre-installed — bootstrap stages put those on
#
# The container is run with --privileged so systemd can manage cgroups.
# This is fine for tests; production uses a real VPS.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
      openssh-server \
      sudo \
      curl ca-certificates \
      iproute2 \
      less \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /run/sshd \
 && ssh-keygen -A \
 && sed -i 's/^#*PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config \
 && sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && sed -i 's/^#*PubkeyAuthentication .*/PubkeyAuthentication yes/' /etc/ssh/sshd_config \
 && systemctl enable ssh

RUN useradd -m -s /bin/bash groundflare \
 && echo 'groundflare ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/groundflare \
 && chmod 440 /etc/sudoers.d/groundflare \
 && install -d -m 0700 -o groundflare -g groundflare /home/groundflare/.ssh

EXPOSE 22

STOPSIGNAL SIGRTMIN+3

CMD ["/sbin/init"]
