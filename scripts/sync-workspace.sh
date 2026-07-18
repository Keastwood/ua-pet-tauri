#!/bin/bash

set -euo pipefail

PET_REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="${DGATES_WORKSPACE:-$(dirname "$PET_REPO")}"
PULL_ONLY=0

if [ "${1:-}" = "--pull-only" ]; then
  PULL_ONLY=1
fi

find_monitor_repo() {
  local candidate remote
  if [ -n "${DGATES_MONITOR_PATH:-}" ]; then
    printf '%s' "$DGATES_MONITOR_PATH"
    return
  fi

  for candidate in \
    "$WORKSPACE_ROOT/ua-monitor" \
    "$WORKSPACE_ROOT/monitor" \
    "$HOME/uatools/monitor" \
    "$HOME/myprojs/ua-monitor"; do
    if [ ! -d "$candidate/.git" ]; then
      continue
    fi
    remote="$(git -C "$candidate" remote get-url origin 2>/dev/null || true)"
    if [[ "$remote" == *"Keastwood/ua-monitor.git"* ]]; then
      printf '%s' "$candidate"
      return
    fi
  done

  printf '%s' "$WORKSPACE_ROOT/ua-monitor"
}

ensure_repo() {
  local path="$1"
  local remote="$2"
  if [ -d "$path/.git" ]; then
    return
  fi
  if [ -e "$path" ]; then
    printf '目录已存在但不是 Git 仓库：%s\n' "$path" >&2
    exit 1
  fi
  printf '首次使用，正在克隆 %s...\n' "$remote"
  git clone "$remote" "$path"
}

ensure_git_identity() {
  local path="$1"
  if [ -z "$(git -C "$path" config user.name || true)" ]; then
    git -C "$path" config user.name "Codex Workspace Sync"
  fi
  if [ -z "$(git -C "$path" config user.email || true)" ]; then
    git -C "$path" config user.email "codex-sync@local"
  fi
}

sync_repo() {
  local label="$1"
  local path="$2"
  local host_name timestamp branch
  host_name="$(hostname -s 2>/dev/null || hostname)"
  timestamp="$(date '+%Y-%m-%d %H:%M:%S %z')"

  printf '\n[%s] %s\n' "$label" "$path"
  git -C "$path" fetch --prune origin

  if [ "$PULL_ONLY" -eq 0 ] && [ -n "$(git -C "$path" status --porcelain)" ]; then
    ensure_git_identity "$path"
    git -C "$path" add -A
    if ! git -C "$path" diff --cached --quiet; then
      git -C "$path" commit -m "chore(sync): checkpoint from $host_name at $timestamp"
    fi
  fi

  branch="$(git -C "$path" branch --show-current)"
  if [ -z "$branch" ]; then
    printf '仓库当前不在普通分支上：%s\n' "$path" >&2
    exit 1
  fi
  if ! git -C "$path" pull --rebase --autostash origin "$branch"; then
    printf '\n同步在变基冲突处停止，没有覆盖文件。\n' >&2
    printf '请在 %s 中解决冲突后运行：git rebase --continue\n' "$path" >&2
    exit 1
  fi

  if [ "$PULL_ONLY" -eq 0 ]; then
    git -C "$path" push origin "$branch"
  fi
}

MONITOR_REPO="$(find_monitor_repo)"
ensure_repo "$MONITOR_REPO" "https://github.com/Keastwood/ua-monitor.git"
ensure_repo "$PET_REPO" "https://github.com/Keastwood/ua-pet-tauri.git"

sync_repo "监控服务" "$MONITOR_REPO"
sync_repo "桌宠" "$PET_REPO"

printf '\n两个项目已%s。\n' "$([ "$PULL_ONLY" -eq 1 ] && printf '下载到最新版本' || printf '完成双向同步')"
