---
name: publish-report
description: Publish a substantial Markdown completion report as a secret GitHub gist and send James its link via ntfy. Use when James asks for a phone-friendly report link after long-running or detailed work, or explicitly invokes this skill; do not use for ordinary brief handoffs.
---

# Publish Report

Finish the requested Markdown report, then:

1. Check that it contains no credentials, tokens, private keys, or other material that should not be accessible by link. GitHub secret gists are unlisted, not access-controlled.
2. Publish the report with `gh gist create`. Keep the gist secret (the default; never pass `--public`), give it a descriptive `.md` filename, and capture the returned URL.
3. Read and use the `ntfy` skill to send a concise completion notification containing the project or task name and the gist URL.
4. Include the gist URL in the normal final handoff as well.

If gist creation fails, do not send a misleading completion notification. Report the failure and preserve the Markdown report locally or in the final response.
