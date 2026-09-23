#!/usr/bin/env bash
# The whole site on your machine: Jekyll rebuilds site/_site as you edit, and
# wrangler serves it together with the session API on http://localhost:8787.
# The API runs against a pretend cloud (worker/src/mock.ts) with no sign-in.
set -euo pipefail
cd "$(dirname "$0")/.."

(cd site && bundle exec jekyll build --quiet)   # wrangler needs site/_site to exist
trap 'kill 0' EXIT
(cd site && bundle exec jekyll build --watch --quiet) &
cd worker && npm run dev
