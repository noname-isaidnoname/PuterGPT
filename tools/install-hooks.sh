#!/bin/sh
# Install the repo's git hooks. Safe to re-run.
# Points git at the versioned .githooks/ directory for the current clone.
set -e

root=$(git rev-parse --show-toplevel 2>/dev/null) || {
    echo "error: not inside a git repository" >&2
    exit 1
}
cd "$root"

git config core.hooksPath .githooks
echo "git hooks installed (core.hooksPath=.githooks). The pre-commit hook will run tools/verify-all.js --changed."
