#!/usr/bin/env bash
set -euo pipefail

# Deploy to remote worker over SSH using DO_SSH from .env
# Optional: DO_WORKDIR to specify absolute repo path on remote host

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Read only DO_SSH and DO_WORKDIR from .env without sourcing the whole file
if [[ -f "$ROOT_DIR/.env" ]]; then
  # shellcheck disable=SC2002
  DO_SSH_RAW=$(cat "$ROOT_DIR/.env" | grep -E '^DO_SSH=' | tail -n 1 | sed -E 's/^DO_SSH=//') || true
  DO_WORKDIR_RAW=$(cat "$ROOT_DIR/.env" | grep -E '^DO_WORKDIR=' | tail -n 1 | sed -E 's/^DO_WORKDIR=//') || true
  DO_SSH_OPTS_RAW=$(cat "$ROOT_DIR/.env" | grep -E '^DO_SSH_OPTS=' | tail -n 1 | sed -E 's/^DO_SSH_OPTS=//') || true
  # Trim surrounding quotes if present
  if [[ -n "$DO_SSH_RAW" ]]; then
    DO_SSH=${DO_SSH_RAW%\"}; DO_SSH=${DO_SSH#\"}
    DO_SSH=${DO_SSH%\'}; DO_SSH=${DO_SSH#\'}
  fi
  if [[ -n "$DO_WORKDIR_RAW" ]]; then
    DO_WORKDIR=${DO_WORKDIR_RAW%\"}; DO_WORKDIR=${DO_WORKDIR#\"}
    DO_WORKDIR=${DO_WORKDIR%\'}; DO_WORKDIR=${DO_WORKDIR#\'}
  fi
  if [[ -n "$DO_SSH_OPTS_RAW" ]]; then
    DO_SSH_OPTS=${DO_SSH_OPTS_RAW%\"}; DO_SSH_OPTS=${DO_SSH_OPTS#\"}
    DO_SSH_OPTS=${DO_SSH_OPTS%\'}; DO_SSH_OPTS=${DO_SSH_OPTS#\'}
  fi
fi

# Read WORKER_ENQUEUE_TOKEN locally (if present) so we can sync it to remote
if [[ -f "$ROOT_DIR/.env" ]]; then
  WORKER_ENQUEUE_TOKEN_RAW=$(cat "$ROOT_DIR/.env" | grep -E '^WORKER_ENQUEUE_TOKEN=' | tail -n 1 | sed -E 's/^WORKER_ENQUEUE_TOKEN=//') || true
  if [[ -n "$WORKER_ENQUEUE_TOKEN_RAW" ]]; then
    WORKER_ENQUEUE_TOKEN=${WORKER_ENQUEUE_TOKEN_RAW%"}; WORKER_ENQUEUE_TOKEN=${WORKER_ENQUEUE_TOKEN#"}
    WORKER_ENQUEUE_TOKEN=${WORKER_ENQUEUE_TOKEN%\'}; WORKER_ENQUEUE_TOKEN=${WORKER_ENQUEUE_TOKEN#\'}
  fi
fi

if [[ -z "${DO_SSH:-}" ]]; then
  echo "❌ DO_SSH is not set in .env (e.g., DO_SSH=user@host)" >&2
  exit 1
fi

read -r -d '' REMOTE_PATH_SCRIPT <<'REMOTE_SCRIPT'
set -euo pipefail
# If the deploy command provided WORKER_ENQUEUE_TOKEN via environment, ensure the remote .env contains a proper line
if [[ -n "${WORKER_ENQUEUE_TOKEN:-}" ]]; then
  # If .env exists, attempt to remove any broken/embedded token fragments and append a clean line
  if [[ -f .env ]]; then
    sed -E 's/WORKER_ENQUEUE_TOKEN=[^[:space:]]+//g' .env > .env.tmp || cp .env .env.tmp
    printf "\nWORKER_ENQUEUE_TOKEN=%s\n" "${WORKER_ENQUEUE_TOKEN}" >> .env.tmp
    mv .env.tmp .env
  else
    printf "WORKER_ENQUEUE_TOKEN=%s\n" "${WORKER_ENQUEUE_TOKEN}" > .env
  fi
  chmod 600 .env || true
fi
if [[ -n "${DO_WORKDIR:-}" && -d "$DO_WORKDIR" ]]; then
  cd "$DO_WORKDIR"
else
  if [[ -d "$HOME/relicxs-workers" ]]; then cd "$HOME/relicxs-workers";
  elif [[ -d "/opt/relicxs-workers" ]]; then cd "/opt/relicxs-workers";
  elif [[ -d "/var/www/relicxs-workers" ]]; then cd "/var/www/relicxs-workers";
  else echo "❌ Could not locate relicxs-workers on remote. Set DO_WORKDIR." >&2; exit 2; fi
fi

# Print context
pwd

# Ensure git present and up-to-date
if command -v git >/dev/null 2>&1; then
  echo "🔄 Pulling latest code..."
  git fetch --all --prune
  # Try to reset to origin/main to avoid local drift
  if git rev-parse --verify origin/main >/dev/null 2>&1; then
    git reset --hard origin/main
  else
    git pull --ff-only || git pull
  fi
else
  echo "❌ git not installed on remote host" >&2
  exit 3
fi

# Install dependencies
if command -v npm >/dev/null 2>&1; then
  echo "📦 Installing dependencies (--production)..."
  npm ci --omit=dev || npm install --production
else
  echo "❌ npm not installed on remote host" >&2
  exit 4
fi

# Reload PM2
if command -v pm2 >/dev/null 2>&1; then
  echo "🚀 Reloading PM2..."
  pm2 reload pm2/ecosystem.config.js || pm2 start pm2/ecosystem.config.js
  pm2 status
else
  echo "❌ pm2 not installed on remote host" >&2
  exit 5
fi

echo "✨ Remote deployment complete"
REMOTE_SCRIPT

# Export DO_WORKDIR for the remote shell if set locally
echo "Using SSH target: $DO_SSH"
echo "Using DO_WORKDIR: ${DO_WORKDIR:-<auto-detect>}"
echo "Using DO_SSH_OPTS: ${DO_SSH_OPTS:-<none>}"

SSH_BASE=(ssh -o BatchMode=yes)
if [[ -n "${DO_SSH_OPTS:-}" ]]; then
  # shellcheck disable=SC2206
  SSH_BASE+=( ${DO_SSH_OPTS} )
fi

if [[ -n "${DO_WORKDIR:-}" ]]; then
  if [[ -n "${WORKER_ENQUEUE_TOKEN:-}" ]]; then
    "${SSH_BASE[@]}" "$DO_SSH" "WORKER_ENQUEUE_TOKEN='${WORKER_ENQUEUE_TOKEN}' DO_WORKDIR='$DO_WORKDIR' bash -s" <<< "$REMOTE_PATH_SCRIPT"
  else
    "${SSH_BASE[@]}" "$DO_SSH" "DO_WORKDIR='$DO_WORKDIR' bash -s" <<< "$REMOTE_PATH_SCRIPT"
  fi
else
  if [[ -n "${WORKER_ENQUEUE_TOKEN:-}" ]]; then
    "${SSH_BASE[@]}" "$DO_SSH" "WORKER_ENQUEUE_TOKEN='${WORKER_ENQUEUE_TOKEN}' bash -s" <<< "$REMOTE_PATH_SCRIPT"
  else
    "${SSH_BASE[@]}" "$DO_SSH" "bash -s" <<< "$REMOTE_PATH_SCRIPT"
  fi
fi
