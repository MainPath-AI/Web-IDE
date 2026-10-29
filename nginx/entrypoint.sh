#!/bin/sh
set -eu
/usr/local/bin/c2w-net --listen-ws 0.0.0.0:8888 -p 18081:8080 &
exec nginx -g "daemon off;"
