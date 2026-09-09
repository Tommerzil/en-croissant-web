# Deploying chess-server

Layout on the host:

    /opt/chess/compose.yaml   (copy of deploy/compose.yaml)
    /opt/chess/.env
    /opt/chess/src/           git clone, branch web
    /opt/chess/data/          db/, documents/, settings.db3
    /opt/chess/engines/       stockfish (seeded), plus anything you drop here

`data/` and `engines/` must be plain directories used as bind mounts, exactly as
compose.yaml declares them. Do not swap either for a named volume: Docker creates
those root-owned, and the entrypoint seeds `stockfish` as the unprivileged app uid.

First deploy:

    sudo mkdir -p /opt/chess && sudo chown "$(id -u):$(id -g)" /opt/chess
    git clone -b web https://github.com/Tommerzil/en-croissant-web.git /opt/chess/src
    cp /opt/chess/src/deploy/compose.yaml /opt/chess/ && cp /opt/chess/src/deploy/env.example /opt/chess/.env
    sed -i "s/^CHESS_UID=.*/CHESS_UID=$(id -u)/; s/^CHESS_GID=.*/CHESS_GID=$(id -g)/" /opt/chess/.env
    mkdir -p /opt/chess/data /opt/chess/engines
    cd /opt/chess && docker compose build && docker compose up -d
    docker image prune -f        # drop dangling images; keeps the cargo/pnpm cache mounts so rebuilds stay warm

Update:

    cd /opt/chess/src && git pull && cd /opt/chess && docker compose build && docker compose up -d

Migrating desktop databases: `deploy/migrate.sh user@host /opt/chess/data` from the
desktop machine. It copies `db/` only — `engines/engines.json` holds desktop-absolute
paths and must not travel.

Upgrading Stockfish: the entrypoint seeds `/data/engines/stockfish` only when the
directory is empty, so a rebuilt image never replaces an existing binary. To take a
newer one, delete `/opt/chess/engines/stockfish` and restart the service.

If the root disk gets tight, `docker builder prune -af` frees the build cache too, at the cost of the next build being cold (10 to 20 minutes).

## Caddy

The site block is committed as `deploy/Caddyfile.chess.example` with
`{$CHESS_DOMAIN}` and `{$CHESS_TAILNET_IP}` placeholders, because this repository is
public and must not name the real host or tailnet address. Take both values from the
existing site blocks in `/etc/caddy/Caddyfile`, render the concrete file, and append
that — never the template:

    sed -e "s|{\$CHESS_DOMAIN}|<domain>|" -e "s|{\$CHESS_TAILNET_IP}|<tailnet-ip>|" \
        /opt/chess/src/deploy/Caddyfile.chess.example > /opt/chess/src/deploy/Caddyfile.chess
    cat /opt/chess/src/deploy/Caddyfile.chess          # check both values really got substituted
    sudo sh -c 'cat /opt/chess/src/deploy/Caddyfile.chess >> /etc/caddy/Caddyfile'
    sudo caddy validate --config /etc/caddy/Caddyfile --envfile /etc/caddy/env
    sudo systemctl reload caddy

Render and read the block before appending it: `/etc/caddy/Caddyfile` is already
serving other sites, and appending an unsubstituted block means hand-editing the live
file to back it out. `deploy/Caddyfile.chess` is gitignored, so the rendered file
survives `git pull` without dirtying the clone.

The Cloudflare token lives in that env file; without `--envfile` validation fails on
the existing sites too. Requires a DNS A record `<domain> -> <tailnet-ip>`.

Port 8090 is published on loopback only (`127.0.0.1:8090:8090`) and must stay that
way. The app's cross-site guard reads fetch-metadata headers, which browsers send
only to trustworthy origins — that is, through Caddy's TLS. A plain-HTTP request
straight to `<host>:8090` carries no such header and bypasses the guard. After
deploying, confirm from another machine that
`curl --max-time 5 http://<tailnet-ip>:8090/api/health` fails to connect.
