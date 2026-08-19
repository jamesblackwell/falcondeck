---
name: ntfy
description: Send James ntfy push notifications for completion, long-command results, blockers, or explicit notify requests.
---

# ntfy Notification

Send notifications to James via the existing ntfy iOS topic:

```bash
curl -fsS \
  -H "Title: FalconDeck" \
  -H "Priority: default" \
  -H "Tags: computer" \
  -d "Message text" \
  https://ntfy.sh/qg_dev_alerts
```

Use concise messages. Include the project name, what happened, and whether attention is needed.

Priorities: `default` for normal completion, `high` for blocked/failed work, `urgent` only when James needs immediate action.
