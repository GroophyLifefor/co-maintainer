#!/bin/sh
set -e
# PIDs restart from a small number in every container, so the PID left in the
# lock file by a killed run can match a live process here and block startup.
rm -f "$XDG_CACHE_HOME/co-maintainer/app.db.lock"
exec node /app/dist/main.js "$@"
