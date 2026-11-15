#!/bin/sh
# Puts the practice project back to how it starts, between dry runs.
cd "$(dirname "$0")" || exit 1
rm -f tasks.json hello.mjs
echo "Practice project reset."
