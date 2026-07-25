#!/bin/sh

set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage Guard bootstrap requires a JavaScript entrypoint." >&2
  exit 64
fi

entrypoint=$1
shift

state_home=${USAGE_GUARD_HOME:-"$HOME/.usage-guard"}
runtime_file="$state_home/node-runtime"
node_runtime=

if [ -r "$runtime_file" ]; then
  IFS= read -r node_runtime < "$runtime_file" || true
fi

if [ -z "$node_runtime" ] || [ "${node_runtime#/}" = "$node_runtime" ] || [ ! -x "$node_runtime" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      node_runtime=$candidate
      break
    fi
  done
fi

if [ -z "$node_runtime" ] || [ ! -x "$node_runtime" ]; then
  echo "Usage Guard could not find its installed Node runtime. Run: usage-guard install" >&2
  exit 69
fi

exec "$node_runtime" "$entrypoint" "$@"
