#!/usr/bin/env bash
# Brings the production stack up with docker compose. First, if the stack's
# network is not on the subnet docker-compose.yml pins, it recreates the
# network.
#
#   bash scripts/deploy-compose-up.sh    (in the checkout, once it is updated)
#
# deploy.yml runs this on the production host in place of a bare
# `docker compose --profile tunnel up -d --build --remove-orphans`.
#
# A Docker network keeps the subnet it was created with. Production's
# agstatus_default was created before docker-compose.yml pinned one, at a
# time when Docker's 172.17-172.31 pools were used up, so Docker gave it
# 192.168.0.0/20. That range holds the host's LAN. Every container on the host
# then routed its LAN traffic into this bridge, so none of them could reach a
# LAN machine.
#
# `up` alone must not move the stack. Compose 2.31 and later (the runner has
# 5.3.1) applies any change to a network's config by recreating the network in
# place. It then puts the existing containers back on the new network without
# their aliases, which are set only when a container is created, and if no
# service's config changed it creates no container. `postgres` and `dashboard`
# would stop resolving: the dashboard exits at startup without its database,
# and cloudflared cannot reach the dashboard. `down` followed by `up` creates
# every container afresh. Never `down -v`: the pg_data volume is the database.
#
# Before the swap, whatever can fail is checked while nothing has stopped yet:
#   - the network belongs to this project;
#   - nothing outside this deploy is attached to it (otherwise `down` keeps
#     the network with only a warning);
#   - Docker accepts the subnet;
#   - the image builds.
# If any check fails, the script exits with AgStatus still running on the old
# network. The swap stops AgStatus for about half a minute, once. Later
# deploys find the subnet right and go straight to `up`.
#
# After every `up`, each of the stack's containers must still answer to its
# service name on the network. If one does not, Compose rebuilt the network in
# place after all. Causes include another change to the network block, a
# `down` that stopped partway, or a deploy run that started before this script
# existed. Recreating the containers puts their names back.
#
# To move off the pinned default, set AGSTATUS_SUBNET in .env: this script
# then applies it with the checked swap. Reverting the pin would bring back
# the bare `up`, and the outage described above with it.
set -euo pipefail

compose() { docker compose --profile tunnel "$@"; }

say() { # say error|warning <message>
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::$1::$2" >&2
  else
    echo "$1: $2" >&2
  fi
}

ipv4_subnets() { # a network's IPv4 subnets, comma-separated
  docker network inspect "$1" --format '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' |
    awk 'index($0, ".") { s = s (s == "" ? "" : ",") $0 } END { print s }'
}

rows() { # what the database holds, for the log; never fails the deploy
  compose exec -T postgres psql -U agstatus -d agstatus -XAtc \
    "SELECT (SELECT count(*) FROM workspaces) || ' workspaces, ' || (SELECT count(*) FROM sessions) || ' sessions'" \
    2>/dev/null || echo "not readable"
}

unnamed() { # the stack's services whose container lacks its service name on $net
  local id svc aliases
  for id in $(compose ps -aq --orphans=false); do
    aliases=$(docker inspect --format "{{with index .NetworkSettings.Networks \"$net\"}}on {{join .Aliases \" \"}}{{end}}" "$id" 2>/dev/null) || continue
    case "$aliases" in on*) ;; *) continue ;; esac # not on this network at all
    svc=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$id" 2>/dev/null) || continue
    case " $aliases " in *" $svc "*) ;; *) printf ' %s' "$svc" ;; esac
  done
}

# The rendered config holds .env's secrets (TUNNEL_TOKEN, POSTGRES_PASSWORD),
# so it stays in this variable and is never printed. Compose quotes a value it
# cannot print bare (a stray space in AGSTATUS_SUBNET, say), and the quoted
# form fails the CIDR check below. That matters because Compose itself would
# reject such a value only after the network is gone.
config=$(compose config)
read -r project net want <<<"$(printf '%s\n' "$config" | awk '
  /^[^ ]/ { top = $1 }
  /^name:/ { project = $2 }
  top == "networks:" && /^  [^ ]/ { def = ($1 == "default:") }
  top == "networks:" && def && $1 == "name:" { net = $2 }
  top == "networks:" && def && $1 == "-" && $2 == "subnet:" { n++; subnet = $0; sub(/^ *- subnet: /, "", subnet) }
  END { print project, net, (n == 0 ? "-" : (n == 1 ? subnet : n " subnets")) }')"

if [ -z "$project" ] || [ -z "$net" ]; then
  say error "docker compose config names no project or default network. Nothing was changed."
  exit 1
fi
ipv4_cidr='^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$'
if [ "$want" != - ] && ! [[ $want =~ $ipv4_cidr ]]; then
  say error "docker compose config gives '$want' as the default network's subnet, where one IPv4 subnet belongs (check AGSTATUS_SUBNET in .env). Nothing was changed."
  exit 1
fi

# A network that is not there is a fresh install. Any other failure to read it
# must not be mistaken for one.
have=
if [ "$want" != - ]; then
  if found=$(docker network inspect "$net" --format '{{.Name}}' 2>&1); then
    have=$(ipv4_subnets "$net")
  elif ! printf '%s\n' "$found" | grep -qi -E 'no such network|not found'; then
    say error "docker network inspect $net failed: $found. Nothing was changed."
    exit 1
  fi
fi

recreated=false
if [ -n "$have" ] && [ "$have" != "$want" ]; then
  echo "Network $net is on $have and docker-compose.yml pins $want. Recreating it stops AgStatus for about half a minute."

  labels=$(docker network inspect "$net" --format '{{index .Labels "com.docker.compose.project"}} {{index .Labels "com.docker.compose.network"}}')
  if [ "$labels" != "$project default" ]; then
    say error "$net is not the default network of Compose project $project (its labels say '$labels'), so it was left alone. AgStatus is still running on $have."
    exit 1
  fi

  # Stopped containers count too: they keep their place on the network. The
  # inspect half also catches an endpoint that has no container.
  ours=$(compose ps -aq --orphans=false)
  attached=$({
    docker ps -aq --no-trunc --filter "network=$net"
    docker network inspect "$net" --format '{{range $id, $ep := .Containers}}{{println $id}}{{end}}'
  } | sed '/^$/d' | sort -u)
  foreign=$(printf '%s\n' "$attached" | grep -vxF -f <(printf '%s\n' "$ours") || true)
  if [ -n "$foreign" ]; then
    names=$(printf '%s\n' "$foreign" | while read -r id; do
      docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's#^/##' || echo "$id"
    done | paste -sd ' ' -)
    say error "Attached to $net but not part of this deploy: $names. Nothing was changed, because down would leave the network in place and up would then fail with AgStatus stopped. Detach them (docker network disconnect $net <name>) and re-run the deploy. AgStatus is still running on $have."
    exit 1
  fi

  probe=agstatus-subnet-probe
  trap 'docker network rm "$probe" >/dev/null 2>&1 || true' EXIT
  docker network rm "$probe" >/dev/null 2>&1 || true
  if ! docker network create --subnet "$want" "$probe" >/dev/null; then
    say error "Docker refuses subnet $want (see above), so nothing was changed. If $want overlaps the network's current $have, Docker cannot test it before the swap: run the one-time down and up by hand (docs/self-hosting.md), or pick a range that does not overlap. Otherwise, set AGSTATUS_SUBNET in .env to a free private range. AgStatus is still running on $have."
    exit 1
  fi
  docker network rm "$probe" >/dev/null

  compose build
  before=$(rows)
  if ! compose down --remove-orphans; then
    say warning "down stopped partway. Bringing the stack back up anyway."
  fi
  recreated=true
  if docker network inspect "$net" >/dev/null 2>&1; then
    say warning "$net is still there after down, so up will rebuild it in place. The name check below then recreates the containers."
  fi
fi

if ! compose up -d --build --remove-orphans; then
  [ "$recreated" = true ] || exit 1
  say warning "up failed right after down. Trying once more in 5 seconds."
  sleep 5
  compose up -d --remove-orphans
fi

lost=$(unnamed)
if [ -n "$lost" ]; then
  say warning "Compose rebuilt $net in place, and these services no longer answer to their names there:$lost. Recreating the stack's containers."
  compose up -d --force-recreate --remove-orphans
  lost=$(unnamed)
  if [ -n "$lost" ]; then
    say error "These services still do not answer to their names on $net:$lost."
    exit 1
  fi
fi

if [ "$want" != - ]; then
  now=$(ipv4_subnets "$net")
  if [ "$now" != "$want" ]; then
    say error "$net is on '$now' after up, not $want."
    exit 1
  fi
  echo "Network $net: $now"
fi
if [ "$recreated" = true ]; then
  echo "Database before the swap: $before. After: $(rows)."
fi
