#!/bin/bash
# Load secrets and run streamline-mcp
set -a
source ~/.config/milo-secrets.env
set +a
exec node /Users/milo/streamline-mcp/dist/index.js "$@"
