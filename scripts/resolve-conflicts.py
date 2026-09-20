#!/usr/bin/env python3
"""Resolve rebase conflicts by keeping the 'theirs' (aa1b2de) side of each hunk."""
import sys

FILES = [
    "/home/z/my-project/src/components/nurae/agents-view.tsx",
    "/home/z/my-project/src/lib/nurae/agents/bot-builder.ts",
    "/home/z/my-project/src/lib/nurae-client/api.ts",
    "/home/z/my-project/src/app/api/agents/sessions/[id]/messages/route.ts",
]

for path in FILES:
    with open(path, "r", encoding="utf-8") as f:
        lines = f.readlines()
    out, mode, hunks = [], "normal", 0
    for ln in lines:
        if ln.startswith("<<<<<<<"):
            mode, hunks = "ours", hunks + 1
            continue
        if ln.startswith("=======") and mode == "ours":
            mode = "theirs"
            continue
        if ln.startswith(">>>>>>>") and mode == "theirs":
            mode = "normal"
            continue
        if mode in ("normal", "theirs"):
            out.append(ln)
    if mode != "normal":
        print(f"ERROR: unbalanced markers in {path}", file=sys.stderr)
        sys.exit(1)
    with open(path, "w", encoding="utf-8") as f:
        f.writelines(out)
    print(f"{path}: {hunks} hunks resolved (kept theirs)")
