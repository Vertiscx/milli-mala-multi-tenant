#!/bin/sh
set -e
[ -n "$TENANTS_JSON" ] && echo "$TENANTS_JSON" > /app/tenants.json
exec node dist/index.js
