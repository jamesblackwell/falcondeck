# FalconDeck Ansible

Ansible lives in-repo so deployment stays reviewable and reproducible, but real server inventory and secrets stay out of git.

## Layout

- `playbooks/bootstrap.yml` prepares a fresh Ubuntu host
- `playbooks/relay.yml` deploys the relay plus the hosted remote web app and site behind Caddy
- `inventory/example/hosts.yml` is a safe example inventory
- `group_vars/all.example.yml` documents the variables you need
- `roles/common` handles base packages and directories
- `roles/caddy` installs and configures Caddy
- `roles/falcondeck_relay` syncs the repo, builds the Linux relay on the server, and installs the systemd unit
- `roles/falcondeck_remote_web` installs workspace dependencies at the repo root, then builds and publishes the hosted remote web client
- `roles/falcondeck_site` builds and publishes the marketing site

## Git Hygiene

These paths are gitignored:

- `inventory/local/`
- `group_vars/*.local.yml`
- `*.vault.yml`
- `.vault-pass`
- `.env`

Keep your real Hetzner IPs, SSH users, TLS email, and any future secrets there.

## Recommended First Deployment Model

Use a plain systemd service plus Caddy reverse proxy first.

Why:

- simplest path for contributors to understand
- fewer moving parts than Docker
- easy to debug on a small VM
- good fit for a single Rust binary

Docker can be added later if we need container-based distribution or multi-service packaging.

## Quick Start

1. Copy the example inventory and vars:

```bash
cd /path/to/falcondeck/ops/ansible
mkdir -p inventory/local group_vars
cp inventory/example/hosts.yml inventory/local/hosts.yml
cp group_vars/all.example.yml group_vars/all.local.yml
```

2. Edit `inventory/local/hosts.yml` and `group_vars/all.local.yml`.

DNS checklist before deploy:

- `falcondeck.com` -> server IP
- `app.falcondeck.com` -> server IP
- `connect.falcondeck.com` -> server IP

If you use Cloudflare, make sure all three records exist before expecting TLS to work on every hostname. The relay and app/site can be proxied later, but the names must resolve first.

3. Bootstrap the host:

```bash
cd /path/to/falcondeck/ops/ansible
ansible-playbook -i inventory/local/hosts.yml playbooks/bootstrap.yml
```

4. Deploy the relay, hosted remote web app, and the public site:

```bash
cd /path/to/falcondeck/ops/ansible
ansible-playbook -i inventory/local/hosts.yml \
  -e @group_vars/all.local.yml \
  playbooks/relay.yml
```

Or from the repo root:

```bash
./deploy.sh
```

The deploy playbook syncs your current checkout to the server, builds the Linux relay there, installs the npm workspace at the repo root, builds both web apps there, and configures Caddy for:

- `connect.falcondeck.com` -> relay
- `app.falcondeck.com` -> hosted remote web app
- `falcondeck.com` -> public site
