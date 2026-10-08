#!/bin/sh
set -eu
: "${REDIS_PASSWORD:?Redis password is required}"
exec redis-server --bind '::' '0.0.0.0' --port 6379 --protected-mode yes \
  --requirepass "$REDIS_PASSWORD" --save '' --appendonly no \
  --maxmemory 128mb --maxmemory-policy noeviction
