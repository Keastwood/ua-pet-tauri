#!/bin/bash

set -e
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
"$ROOT_DIR/scripts/sync-workspace.sh" "$@"
printf '\n按回车关闭此窗口...'
read -r
