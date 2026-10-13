# FalconDeck Ansible

Ansible lives in-repo so deployment stays reviewable and reproducible, but real server inventory and secrets stay out of git.

## Layout

- `playbooks/bootstrap.yml` prepares a fresh Ubuntu host
- `playbooks/relay.yml` deploys the relay, builds the web apps, and serves the public site and pairing landing behind Caddy
- `inventory/example/hosts.yml` is a safe example inventory
- `group_vars/all.example.yml` documents the variables you need
- `roles/common` handles base packages and directories
- `roles/caddy` installs and configures Caddy
- `roles/falcondeck_relay` syncs the repo, builds the Linux relay on the server, and installs the systemd unit
- `roles/falcondeck_dist` builds the Linux daemon on the server and publishes it (plus a `.sha256`) to the `/dist/` download directory
- `roles/falcondeck_remote_web` installs workspace dependencies at the repo root, then builds and publishes the hosted remote web client
- `roles/falcondeck_site` builds and publishes the marketing site

## Git Hygiene

These paths are gitignored:

- `inventory/local/`
- `group_vars/*.local.yml`
- `*.vault.yml`
- `.vault-pass`
- `.env`

Keep real server addresses, SSH users, TLS email, and secrets there.

## Deployment model

The relay runs as a systemd service behind Caddy. Docker is not required.
The playbook also builds the browser client, but the current Caddy template
serves the public site on the pairing hostname. Hosting the browser client
separately requires a static-site configuration for its built assets.

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

- `falcondeck_site_domain` -> server IP
- `falcondeck_app_domain` -> server IP
- `falcondeck_relay_domain` -> server IP

If you use Cloudflare, make sure all three records exist before expecting TLS to work on every hostname. The relay and app/site can be proxied later, but the names must resolve first.

3. Bootstrap the host:

```bash
cd /path/to/falcondeck/ops/ansible
ansible-playbook -i inventory/local/hosts.yml playbooks/bootstrap.yml
```

4. Deploy the relay and web assets:

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

- `falcondeck_relay_domain` -> relay
- `falcondeck_app_domain` -> public site and mobile pairing landing
- `falcondeck_site_domain` -> public site

For FalconDeck's hosted deployment, those names are `connect.falcondeck.com`,
`app.falcondeck.com`, and `falcondeck.com`. Use your own domains when self-hosting.

It also builds the Linux daemon on the server and publishes it for remote provisioning
at your configured relay URL (shown here with the hosted URL):

- `https://connect.falcondeck.com/dist/falcondeck-daemon-x86_64-linux`
- `https://connect.falcondeck.com/dist/falcondeck-daemon-x86_64-linux.sha256`

The naming contract is `{relay_url}/dist/falcondeck-daemon-{arch}-linux`, where `arch` is `uname -m` on the target machine.
