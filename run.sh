#!/bin/bash
# Load secrets and run streamline-mcp
set -a
source ~/.openclaw/.env
set +a
exec node /Users/milo/streamline-mcp/dist/index.js "$@"
