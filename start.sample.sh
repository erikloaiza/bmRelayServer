#!/bin/bash
deno run $* --inspect --allow-read --allow-net bmRelayServer.ts 8443
#
#
#pm2 start bmRelayServer.ts --time --node-args="8443 TLS" --interpreter="/root/.deno/bin/deno" --interpreter-args="run --allow-net --allow-read "
