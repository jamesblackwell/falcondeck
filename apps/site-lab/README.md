# FalconDeck marketing site (lab)

A sandbox copy of `apps/site` for locally testing ideas without touching the
main marketing site. Not wired into `make build`, deploy, or Ansible.

## Run locally

From the monorepo root:

```bash
npm run dev --workspace falcondeck-site-lab
```

The lab site runs at [http://localhost:4176](http://localhost:4176).

## Syncing

Changes here do not flow back to `apps/site` automatically. When an idea is
ready, port it to `apps/site` manually and delete it here.
