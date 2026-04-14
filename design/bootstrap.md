# DESIGN: `groundflare` Day-0 Bootstrap

> What automatic steps must happen between "fresh VPS account" and "Worker is live" — so the user never touches a Linux server.

Status: v0 draft. This doc defines the boundary between "we automate it" and "we expose the lever."

## The core assumption

> The typical Cloudflare Workers user is a JS/TS developer with zero (or near-zero) Linux/devops experience.

This is not condescending — it is empirical. CF Workers explicitly removed devops from the developer's plate; that's why they exist. The day a CF Workers user runs `groundflare up`, they should not need to know what `ufw`, `fail2ban`, `journald`, or `systemd unit` mean.

**Every decision in this doc follows from that one constraint.**

If experienced sysadmins want the levers, they can SSH in and override after the fact — groundflare uses standard tools (Caddy, systemd, UFW, apt packages), not a closed system. The **production runtime is native** — workerd, Caddy, and Redis all run as systemd services, not in containers. Docker is used only for local VPS simulation during development and CI (see [§ Local testing](#local-testing-via-docker)). But the **default path requires zero knowledge**.

## The contract

After `groundflare up` completes (target: 3-5 minutes from zero), the VPS has:

- ✅ Latest stable OS with security patches applied
- ✅ Hardened SSH (key-only, root disabled, fail2ban active)
- ✅ Firewall (UFW: only 22, 80, 443 inbound)
- ✅ workerd binary installed at `/usr/local/bin/workerd` (Mirror) or Bun at `/usr/local/bin/bun` (Bun track)
- ✅ Caddy reverse proxy with auto-SSL via Let's Encrypt
- ✅ systemd units supervising the Worker runtime and adapters
- ✅ Adapter services running as needed (Redis for KV, libSQL embedded, MinIO for R2 if not on CF)
- ✅ restic backups configured (B2/R2 destination, nightly)
- ✅ Auto unattended-upgrades for security patches
- ✅ Swap file sized to RAM
- ✅ Tuned ulimits + sysctl for high-traffic Node-style apps
- ✅ Prometheus-format `/metrics` + `/health` endpoints exposed
- ✅ Structured JSON logs to journald with rotation
- ✅ Healthcheck timer + auto-restart on failure
- ✅ `/etc/groundflare/config.toml` recording every decision (for audit + idempotent re-runs)

The user did none of this — they ran one command.

## Pipeline stages

10 stages, idempotent end-to-end. Re-running `groundflare up` after any failure resumes from last successful stage.

```
┌──────────────────────────────────────────────────┐
│  Stage 0:  Authenticate with VPS provider         │
│  Stage 1:  Manage SSH keys                        │
│  Stage 2:  Provision VPS                          │
│  Stage 3:  Wait for boot, install cloud-init      │
│  Stage 4:  Base hardening (SSH, UFW, fail2ban)    │
│  Stage 5:  System tuning (swap, ulimits, sysctl)  │
│  Stage 6:  Install workerd + Caddy + adapters     │
│  Stage 7:  Configure backups (restic)             │
│  Stage 8:  Configure auto-updates                 │
│  Stage 9:  Configure observability                │
│  Stage 10: Deploy Worker, verify health           │
└──────────────────────────────────────────────────┘
```

Each stage detail below.

---

### Stage 0: Provider authentication

**Purpose:** Get authenticated against the VPS provider's API.

**Default:** Hetzner (cheapest tier, EU/US/AP regions, 20 TB free traffic).

**UX:**
```
$ groundflare up
? No VPS provider linked. Open Hetzner signup? [Y/n]
→ Opens https://accounts.hetzner.com in browser
? Once signed up, paste API token (from console.hetzner.cloud/projects):
[paste]
✓ Token validated (Hetzner project: my-project)
```

Token stored in OS keychain (macOS Keychain / Windows Credential Manager / libsecret on Linux). Never written to disk in plaintext.

**Override:** `--provider digitalocean | linode | vultr | contabo` (priority order based on global popularity + price).

---

### Stage 1: SSH key management

**Purpose:** Create + register an SSH key dedicated to groundflare. Never reuse the user's personal key.

**Action:**
1. Generate `~/.config/groundflare/keys/<vps-name>_ed25519` (4096-bit Ed25519)
2. Upload public key to VPS provider via API
3. Tag key with name `groundflare-<machine>-<timestamp>`

**Why a dedicated key:** Easy revocation, audit log, no risk of compromising the user's GitHub/personal SSH access.

**Override:** `--ssh-key ~/.ssh/id_ed25519` if user wants to reuse existing.

---

### Stage 2: VPS provision

**Purpose:** Create the actual machine.

**Default sizing logic** (if user didn't specify `--size`):
- If user previously ran `groundflare estimate`, use recommended tier
- Else: ask `What size? [cx22 $4.80/mo, cx32 $7.50/mo, cx42 $14/mo]` with cx22 preselected

**Default region logic:**
- Detect user's IP location → pick nearest (e.g. Taiwan IP → Singapore-equivalent)
- For Hetzner: `hel1 / fsn1 / nbg1 (EU)` or `ash / hil (US)` or `sin (AP, planned)`

**Action:** Single API call, returns IP.

**Failure mode:** API quota / payment method missing → error with link to provider's billing page.

---

### Stage 3: Boot wait + cloud-init

**Purpose:** Wait for SSH to be reachable, then run initial setup.

**Action:**
1. Poll port 22 every 3 seconds, max 120 seconds
2. Inject cloud-init user-data at provision time (Hetzner / DO support this):
   ```yaml
   #cloud-config
   package_update: true
   package_upgrade: true
   packages:
     - caddy
     - redis-server
     - ufw
     - fail2ban
     - unattended-upgrades
     - restic
     - jq
     - curl
     - htop
   users:
     - name: groundflare
       sudo: ALL=(ALL) NOPASSWD:ALL
       ssh-authorized-keys:
         - <pubkey from Stage 1>
   ```

3. Wait for cloud-init completion (`/var/lib/cloud/instance/boot-finished` exists)

**Why cloud-init:** It runs once on first boot, atomically, before SSH is even available. Faster + safer than SSHing in to install packages.

---

### Stage 4: Base hardening (SSH, UFW, fail2ban)

**Purpose:** Lock down the box.

**SSH config (`/etc/ssh/sshd_config.d/groundflare.conf`):**
```
PermitRootLogin no
PasswordAuthentication no
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
AllowUsers groundflare
```

**UFW rules:**
```
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP (Caddy → Let's Encrypt)'
ufw allow 443/tcp comment 'HTTPS (Caddy)'
ufw enable
```

**fail2ban (`/etc/fail2ban/jail.d/groundflare.conf`):**
```ini
[sshd]
enabled = true
maxretry = 3
findtime = 600
bantime = 3600

[caddy]
enabled = true
maxretry = 10
findtime = 60
bantime = 600
```

**Why these defaults:** Standard CIS-aligned hardening. None are surprising; all are the lowest-friction "secure by default" baseline.

---

### Stage 5: System tuning

**Purpose:** Avoid the silent failures that make Node-style apps die under load on small VPS.

**Swap:** Create swap file = 1× RAM (capped at 4 GB), `/swapfile`, `swappiness=10`.
Without this, OOM killer murders the Worker process when memory spikes.

**ulimits (`/etc/security/limits.d/groundflare.conf`):**
```
groundflare soft nofile 65536
groundflare hard nofile 65536
groundflare soft nproc 8192
groundflare hard nproc 8192
```

**sysctl (`/etc/sysctl.d/99-groundflare.conf`):**
```
# Network tuning for many concurrent HTTP connections
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.ip_local_port_range = 1024 65535
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 15

# File watchers (in case Worker needs them)
fs.inotify.max_user_watches = 524288
```

**Why these defaults:** These are the things that bite a small VPS at >100 RPS. Hidden so the user never has to discover them via 3 AM outage.

---

### Stage 6: Install workerd + Caddy + adapters

**Purpose:** Get the Worker runtime and supporting services installed as native systemd units.

**workerd binary:**
- Download from npm (`workerd` package ships a platform binary) or GitHub release
- Extract to `/usr/local/bin/workerd`
- Version pinned by `compatibility_date` in `wrangler.toml`
- `chmod +x`, verify signature

**systemd unit (`/etc/systemd/system/groundflare-worker.service`):**
```ini
[Unit]
Description=groundflare worker runtime
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
User=groundflare
Group=groundflare
WorkingDirectory=/var/lib/groundflare/workers/current
EnvironmentFile=/etc/groundflare/environment
ExecStart=/usr/local/bin/workerd serve worker.capnp --verbose
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536
MemoryMax=80%
CPUQuota=80%

[Install]
WantedBy=multi-user.target
```

Vars from `[vars]` in wrangler.toml are written to `/etc/groundflare/environment` as `KEY=value` lines.

**Caddy config (`/etc/caddy/Caddyfile`) — generated:**
```
{
  email <user-email-from-config>
  acme_ca https://acme-v02.api.letsencrypt.org/directory
}

<worker-name>.<user-domain-or-groundflare-app>.com {
  reverse_proxy localhost:8080
  encode gzip zstd
  log {
    output stdout
    format json
  }
}
```

Caddy is installed via the official apt repository; the unit file ships with the package.

**Default domain strategy:**
- If user has DNS configured → use their domain
- Else: assign `<worker-name>-<random>.groundflare.app` (we operate this domain, point to user's VPS via wildcard)
- Wildcard SSL via Let's Encrypt DNS-01 (Caddy plugin)

**Adapter services (only if used):**
- Redis (`redis-server` apt package, systemd-managed): KV adapter target, bound to `127.0.0.1:6379`
- libSQL: linked into workerd (D1 adapter), no separate service
- MinIO (optional, single-binary install + systemd unit): R2 adapter target when user opts out of CF R2

No Docker daemon, no containers, no compose files. Each service is a first-class systemd unit with its own logs in journald.

---

### Stage 7: Configure backups

**Purpose:** Restore-from-disaster path that the user never has to think about.

**restic config:**
```bash
RESTIC_REPOSITORY=b2:groundflare-backups-<account-id>:<machine-name>
RESTIC_PASSWORD=<generated, stored in keychain locally + /etc/groundflare/secrets locally>
```

**What gets backed up:**
- `/var/lib/groundflare/d1/*.sqlite` (databases)
- `/var/lib/groundflare/kv/dump.rdb` (Redis snapshot)
- `/etc/groundflare/config.toml` (system config)
- `/etc/caddy/Caddyfile` (proxy config)

**What does NOT get backed up:**
- R2 buckets (already replicated by S3-compatible store)
- Worker code (already in user's git repo)
- OS config (rebuildable from groundflare bootstrap)

**Schedule:** Nightly at 02:00 local + on-demand `groundflare backup now`.
**Retention:** 7 daily + 4 weekly + 6 monthly.

**Default destination:** Backblaze B2 (cheapest object storage for small data, $6/TB/mo).
**Override:** `--backup r2:bucket-name` / `--backup s3://...` / `--backup none` (user opts out, takes responsibility).

---

### Stage 8: Configure auto-updates

**Purpose:** OS security patches apply themselves.

**unattended-upgrades config (`/etc/apt/apt.conf.d/50unattended-upgrades`):**
```
Unattended-Upgrade::Allowed-Origins {
  "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "03:00";
Unattended-Upgrade::Mail "<user-email>";
Unattended-Upgrade::MailReport "on-change";
```

**Worker container updates:** Separate cadence — user runs `groundflare upgrade` explicitly. Never auto-updated, because it's the user's app code.

**Adapter containers (Redis / MinIO):** Pinned tags, updated only when user runs `groundflare upgrade --adapters`.

**workerd version:** Tracks user's `compatibility_date` in `wrangler.toml` (matches CF behavior).

---

### Stage 9: Configure observability

**Purpose:** When something breaks, the user can see what.

**Metrics endpoint:** `http://localhost:9090/metrics` (Prometheus format), exposed on `127.0.0.1` only. Includes:
- `groundflare_requests_total{status, route}`
- `groundflare_request_duration_seconds{route}` (histogram)
- `groundflare_do_instances_active`
- `groundflare_kv_ops_total{op}`
- `groundflare_d1_query_duration_seconds`
- `groundflare_runtime_memory_bytes`

**Health endpoint:** `http://localhost:9091/health` — returns 200 if Worker + DB + adapters all OK.

**Logs:** Worker writes structured JSON to stdout → systemd unit's `StandardOutput=journal` captures directly into journald → rotated by `systemd-journald` automatically. `groundflare tail` SSHs in and streams `journalctl -fu groundflare-worker`.

**Alerts:** Optional webhook fired by groundflare-runtime when:
- Health check fails 3 consecutive times → POST to user's webhook
- Disk > 80% → email
- Memory > 90% sustained → email
- Backup failure → email

**Default alert delivery:** email via SMTP relay (user provides SMTP creds OR uses groundflare's free relay tier with 100 emails/mo).

---

### Stage 10: Deploy Worker, verify health

**Purpose:** Push the user's actual Worker code, verify everything works.

**Action:**
1. Build Worker locally (using `wrangler` toolchain — we don't reinvent the bundler)
2. Generate `groundflare.config.toml` from `wrangler.toml` (translation layer)
3. Push artifact via SCP to `/var/lib/groundflare/workers/<name>/`
4. Send `SIGHUP` to groundflare-runtime container (zero-downtime reload)
5. Hit `/health` endpoint, expect 200 within 10 seconds
6. If fail: roll back to previous artifact, surface error

**Output:**
```
✓ VPS provisioned (Hetzner CX22, hel1)             [42s]
✓ OS bootstrapped + hardened                       [78s]
✓ workerd + Caddy + Redis installed                [54s]
✓ Backups configured (B2)                          [12s]
✓ Worker deployed                                  [8s]
✓ Health check passed

🟢 Live at https://my-worker-abc.groundflare.app
   Total time: 3m 14s
   Cost: $4.80/mo (Hetzner CX22) + $0/mo (groundflare)
```

---

## Idempotency

Every stage:
- Records its completion in `/etc/groundflare/state.json` on the VPS
- Re-running `groundflare up` checks state and resumes from last unfinished stage
- Each stage is also reversible via `groundflare reset --stage <n>`

This is critical: if Stage 7 fails because B2 credentials are wrong, the user doesn't redo the 5 minutes of provisioning + hardening. They fix B2 and re-run.

## Provider abstraction

```
┌────────────────────────────────────────────────┐
│  groundflare-cli                               │
│  ├─ provider/                                  │
│  │  ├─ hetzner.ts        (default)             │
│  │  ├─ digitalocean.ts                         │
│  │  ├─ linode.ts                               │
│  │  ├─ vultr.ts                                │
│  │  └─ contabo.ts                              │
│  └─ bootstrap/                                 │
│     ├─ stage-0-auth.ts                         │
│     ├─ stage-1-ssh.ts                          │
│     ├─ stage-2-provision.ts  (calls provider)  │
│     ├─ stage-3-boot.ts                         │
│     ├─ stage-4-harden.ts                       │
│     └─ ...                                     │
└────────────────────────────────────────────────┘
```

Each provider implements `Provider` interface:
```ts
interface Provider {
  authenticate(token: string): Promise<Account>
  listSizes(): Promise<Size[]>
  listRegions(): Promise<Region[]>
  createVPS(opts: ProvisionOpts): Promise<VPS>
  destroyVPS(id: string): Promise<void>
  uploadSSHKey(pub: string): Promise<KeyId>
  estimateMonthlyCost(size: Size): number
}
```

Stages 3-10 are **provider-agnostic** — they only need SSH access.

## Region selection

Default policy:
- Detect user's home region via IP geolocation (with `--region auto`)
- Map to nearest provider region
- Confirm with user before provisioning (don't surprise them with billing region)

**Override:** `--region eu-central-1` etc. (provider-specific codes documented).

## Secret bootstrapping

Initial secrets needed on VPS:
- B2 application key (for restic)
- SMTP password (if alerts enabled)
- User's wrangler-defined secrets (`wrangler secret list` → re-injected)

Flow:
1. `groundflare secret pull` (locally) reads from `wrangler secret` API
2. Secrets encrypted with VPS's age key (generated during bootstrap)
3. Secrets pushed to `/etc/groundflare/secrets/` (mode 0600, owner groundflare)
4. groundflare-runtime mounts `/etc/groundflare/secrets/` read-only
5. On rotation (`groundflare secret put`), atomic replace + container reload

**No secrets in:** environment variables visible in `ps`, log output, or `groundflare.config.toml`.

## Disaster recovery

`groundflare restore` flow:
1. Provision new VPS (Stages 0-9)
2. `restic restore latest` from configured B2 destination
3. Re-deploy Worker (Stage 10)

DNS cutover: user re-points A record to new IP (or Caddy's auto-cert reissues if domain still valid).

**RTO target:** < 10 minutes for a small Worker. **RPO:** < 24 hours (last nightly backup).

For tighter RPO, future `--backup-frequency hourly` mode.

## Day-N operations

After bootstrap, ongoing operations users can run:

| Command | What it does |
|---|---|
| `groundflare deploy` | Push new Worker code (zero-downtime) |
| `groundflare tail` | Live structured logs |
| `groundflare status` | VPS health + cost so far this month |
| `groundflare upgrade` | OS patches + adapter containers (prompts approval) |
| `groundflare backup now` | Trigger restic backup |
| `groundflare backup list` | List snapshots |
| `groundflare restore --to <new-vps>` | Disaster recovery |
| `groundflare doctor` | Re-verify all bootstrap stages (idempotent re-check) |
| `groundflare destroy` | Tear down VPS, archive backups, delete domain |

## What we deliberately do NOT automate

- **Multi-region deployment** (out of scope for v1; adds CRDT/replication complexity)
- **Database scaling** (single-node SQLite/Redis/MinIO is the v1 promise)
- **Custom DNS providers** (we manage `*.groundflare.app` only; for custom domains, user runs `groundflare domain add` and manages their own DNS records)
- **User-supplied OS images** (Ubuntu LTS only; supporting Alpine/Fedora/etc. multiplies hardening surface)
- **Container orchestration** (no Kubernetes, no production Docker; if user needs k8s they're not the target)

These are the levers experienced sysadmins might want. We don't expose them in v1 because every option increases the surface area of "things that can go wrong without you knowing why."

## Risk matrix

| Risk | Mitigation |
|---|---|
| Provider API changes break provisioning | Pin SDK versions; integration tests against each provider |
| Bootstrap fails halfway | Idempotent stage state, `groundflare doctor` to re-check |
| User's payment method declined | Surface provider's exact error message + link to billing |
| Restic backup destination unreachable | Alert + fall back to local snapshot until restored |
| Let's Encrypt rate limit hit | Caddy auto-falls-back to staging cert, alerts user |
| Auto-update breaks Worker | Updates are security-only, never feature; reboot at 03:00 if needed; rollback via `groundflare upgrade --rollback` |
| User loses their SSH key | `groundflare reset-key` regenerates + re-uploads via provider API |
| User loses access to provider account | Same — provider account is their responsibility; we document recovery |

## Local testing via Docker

Although the production runtime on a real VPS is pure native (systemd + binaries, no containers), **local development and CI use Docker to simulate a fresh Ubuntu 24.04 VPS**. This lets contributors iterate on bootstrap stages without provisioning real cloud machines.

### Flow

```bash
groundflare test bootstrap --local
# Starts an ubuntu:24.04 container with systemd enabled
# Injects a generated cloud-init user-data via env
# Runs stages 4-10 against the container over SSH (localhost:2222)
# Deploys the examples/hello worker
# Asserts /health returns 200
# Tears down the container
```

### Why Docker here specifically

- **Cheap**: no billing, no network flakiness, seconds to spin up vs minutes to provision a real VPS
- **Deterministic**: same base image every run, CI-friendly
- **Isolated**: broken bootstrap scripts don't leak into the developer's host
- **Native-compatible**: systemd-in-Docker (via `--privileged` + `/sbin/init`) is mature enough that stages 4-9 behave identically to a real VPS

### Image contract

- Base: `ubuntu:24.04` (official image)
- No groundflare bits baked in — everything comes from cloud-init + Stage 6 downloads
- Exposed ports: 22 (SSH), 80/443 (forwarded to host for Caddy testing)
- `tini` or `systemd-as-PID1` for proper signal handling

### Not production

The Docker simulation is **only** for testing groundflare's own bootstrap tooling. It is never shipped, never used for customer deployments, and never suggested as a hosting option. A real VPS from a real provider is always the production target.

## Roadmap

| Version | Scope | Time |
|---|---|---|
| **v0.1** | Manual deploy to existing VPS (skip Stages 0-3, just 4-10) | 3 weeks |
| **v0.2** | Add Stages 0-3 for Hetzner only | 2 weeks |
| **v0.3** | Add DO + Linode providers | 2 weeks |
| **v0.4** | Add backup/restore (Stage 7 + restore CLI) | 2 weeks |
| **v0.5** | Add observability (Stage 9 fully wired) | 2 weeks |
| **v0.6** | Add disaster recovery (`groundflare restore`) | 1 week |
| **v1.0** | Vultr + Contabo providers + multi-region selection | 2 weeks |
| **v1.5** | Custom domain + DNS automation | 3 weeks |

**Total v1.0:** ~14 weeks for a focused team. Solo: 6+ months.

## Open questions

1. **`*.groundflare.app` wildcard ownership.** Do we operate this domain? It's required for the "zero-DNS-config first deploy" UX. Cost: ~$15/yr for the domain + DNS infrastructure. Worth it.
2. **B2 credentials.** Do we provide a default groundflare-managed B2 bucket (we pay) for users who haven't set up their own? Adds free-tier value, adds liability. Leaning: **no**, ask user to provide; offer a one-click B2 signup link.
3. **Email alert relay.** Same question — do we run an SMTP relay (with cap) as a free-tier perk? Leaning: **yes, 100 emails/mo free**, paid tier for more.
4. **Auto-reboot on kernel updates.** Required for security but interrupts users. Leaning: **default 03:00 reboot, configurable, with 5-day max staleness force-reboot**.
5. **What happens when provider API tokens expire?** We can detect via `groundflare doctor`. Should we email warn? Leaning: **yes, 7 days before expiry if known**.
