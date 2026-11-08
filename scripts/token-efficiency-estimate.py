#!/usr/bin/env python3
"""Read local Analytics usage; print aggregates and explicit scenario estimates.

No daemon/provider/device calls. No message content, thread IDs or secrets are
printed. This is a scenario calculator, not a causal before/after measurement.
"""
import argparse
from datetime import datetime
import json
from pathlib import Path
import re
import subprocess


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def literal_chars(source, start, end):
    source = source[source.index(start):]
    source = source[:source.index(end)]
    source = re.sub(r"\\\n\s*", "", source)
    total = 0
    for raw in re.findall(r'"(?:\\.|[^"\\])*"', source):
        try:
            total += len(json.loads(raw))
        except ValueError:
            pass  # Rust-only escapes, not counted in either version.
    return total


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".falcondeck")
    parser.add_argument("--start", default="2026-11-03T14:15:00Z")
    parser.add_argument("--end", default="2026-11-07T16:37:00Z")
    parser.add_argument("--base", default="b06c5eb3")
    args = parser.parse_args()
    start, end = timestamp(args.start), timestamp(args.end)
    if end <= start:
        parser.error("end must be after start")
    weekly = 604800 / (end - start).total_seconds()
    rows = {}
    for path in sorted((args.state_dir / "analytics").glob("usage-*.jsonl")):
        with path.open() as handle:
            for line in handle:
                try:
                    row = json.loads(line)
                    if row.get("e") == "usage" and start <= timestamp(row["t"]) <= end:
                        rows[row["id"]] = row
                except (ValueError, KeyError):
                    continue  # A concurrently appended final line may be partial.
    claude = [row for row in rows.values() if row.get("prov") == "claude"]
    if not claude:
        parser.error("no Claude usage in the requested Analytics window")
    repo = Path(__file__).resolve().parents[1]
    reductions = {}
    for file, begin, finish in [
        ("crates/falcondeck-daemon/src/agent_context.rs", "pub fn append_instructions", "#[cfg(test)]"),
        ("crates/falcondeck-daemon/src/control/mcp.rs", "fn tool_description", "async fn handle_tool_call"),
        ("crates/falcondeck-daemon/src/app/thread_tools.rs", "pub(super) fn catalog", "#[derive(Deserialize, Default)]"),
    ]:
        old = subprocess.check_output(["git", "show", f"{args.base}:{file}"], cwd=repo, text=True)
        new = (repo / file).read_text()
        reductions[file] = literal_chars(old, begin, finish) - literal_chars(new, begin, finish)
    file = "crates/falcondeck-daemon/src/agent_context/falcondeck-mcp/SKILL.md"
    old = subprocess.check_output(["git", "show", f"{args.base}:{file}"], cwd=repo, text=True)
    reductions[file] = len(old.splitlines()[2]) - len((repo / file).read_text().splitlines()[2])
    removed_tokens = sum(reductions.values()) / 2.8
    print(json.dumps({
        "window": {"start": args.start, "end": args.end, "weekly_multiplier": round(weekly, 4)},
        "analytics": {"claude_usage_records": len(claude),
            "reported_cost_weekly": round(sum(r.get("cost") or 0 for r in claude) * weekly, 2),
            "cache_read_tokens_weekly": round(sum(r.get("cr", 0) for r in claude) * weekly),
            "cache_write_tokens_weekly": round(sum(r.get("cw", 0) for r in claude) * weekly)},
        "context_characters_removed": reductions,
        "context_tokens_removed_approx": round(removed_tokens),
        "estimated_weekly_list_equivalent_usd": {
            "fix3_review_replay_marginal_ceiling": 86,
            "fix4_bash_standalone_interpolation": 13 * (30000 - 24000) / (30000 - 20000),
            "fix4_bash_marginal_interpolation": round(13 * 0.6 * 71 / 84, 2),
            "fix5_proportional_standalone_ceiling": round(64 * removed_tokens / 6000, 2),
            "fix5_proportional_marginal_ceiling": round(75 * removed_tokens / 6000, 2)},
        "limits": "Scenario estimates from docs/token-efficiency-review.md, not realized savings. "
            "Fix3 skips cold/sleep windows. Fix4 interpolates replay caps; MCP saving unpriced. "
            "Fix5 assumes all shortened text is loaded; deferred tools lower coverage. "
            "Character/token ratios vary. CLI costs are list-equivalent, not invoices."
    }, indent=2))


if __name__ == "__main__":
    main()
