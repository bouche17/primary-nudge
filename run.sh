#!/bin/bash
# usage: run.sh '<json body>'  — single-instance (flock), sequential chunks, background-safe
exec 9>/tmp/suite/lock; flock -n 9 || { echo "ANOTHER RUN IN PROGRESS"; exit 1; }
cd /tmp/suite; body="$1"
URL=https://cfjcuhblioswylmtclzy.supabase.co/functions/v1/monty-test-runner
ANON=$(grep PUBLISHABLE /dev-server/.env | cut -d'"' -f2)
for i in $(seq 1 30); do
  n=$(cat next_token); t=$(sed -n "${n}p" tokens.txt); echo $((n+1)) > next_token
  out=$(curl -s -m 170 $URL -H "x-runner-token: $t" -H "apikey: $ANON" -H "content-type: application/json" -d "$body")
  echo "$out" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("run_id"),d.get("total"),"failed",d.get("failed"),"flaky",d.get("flaky"),d.get("next"),d.get("error"))' || { echo "BAD: $out" | head -c 300; break; }
  body=$(echo "$out" | python3 -c 'import sys,json;d=json.load(sys.stdin);n=d.get("next");print(json.dumps({"action":"full_suite","run_id":d["run_id"],**n}) if n else "")')
  [ -z "$body" ] && break
done; echo DONE
