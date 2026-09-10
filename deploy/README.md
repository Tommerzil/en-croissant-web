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
    # also check CHESS_CPUS in .env: it must be <= `nproc`, or `docker compose up` fails outright
    mkdir -p /opt/chess/data /opt/chess/engines
    cd /opt/chess && docker compose build && docker compose up -d
    docker image prune -f        # drop dangling images; keeps the cargo/pnpm cache mounts so rebuilds stay warm

Then do the one-time Caddy setup below to put the site on TLS; until that is done the
app is reachable only on the host's own loopback.

Update:

    cd /opt/chess/src && git pull && cd /opt/chess && docker compose build && docker compose up -d

That is the whole update path. The Caddy section below is **one-time setup** and must
not be repeated: running it again appends a second copy of the site block and Caddy
then refuses to load the config. If a `git pull` brings a changed
`Caddyfile.chess.example`, re-render `Caddyfile.chess` and *replace* the existing
block in `/etc/caddy/Caddyfile` — edit it in place, or strip the old block out of the
candidate file before the validate-then-copy sequence below. Never append again.

Migrating desktop databases: quit the En Croissant desktop app first — the game
databases are SQLite in journal mode `delete`, so a copy taken while the app is
writing can be torn. Then run `deploy/migrate.sh user@host /opt/chess/data` from the
desktop machine. It copies `db/` only — `engines/engines.json` holds desktop-absolute
paths and must not travel.

Upgrading Stockfish: the entrypoint seeds `/data/engines/stockfish` only when that
path is absent — no file and no symlink there — so a rebuilt image never replaces an
existing binary. To take a
newer one, delete `/opt/chess/engines/stockfish` and restart the service.

If the root disk gets tight, `docker builder prune -af` frees the build cache too, at the cost of the next build being cold (10 to 20 minutes).

## Caddy

The site block is committed as `deploy/Caddyfile.chess.example` with
`{$CHESS_DOMAIN}` and `{$CHESS_TAILNET_IP}` placeholders, because this repository is
public and must not name the real host or tailnet address. Take both values from the
existing site blocks in `/etc/caddy/Caddyfile`, render the concrete file — never use
the template directly — then build a candidate config, validate *that*, and only
replace the live file once it validates:

    sed -e "s|{\$CHESS_DOMAIN}|<domain>|" -e "s|{\$CHESS_TAILNET_IP}|<tailnet-ip>|" \
        /opt/chess/src/deploy/Caddyfile.chess.example > /opt/chess/src/deploy/Caddyfile.chess
    cat /opt/chess/src/deploy/Caddyfile.chess          # check both values really got substituted
    sudo cp -a /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.$(date +%F).bak"
    { sudo cat /etc/caddy/Caddyfile; echo; cat /opt/chess/src/deploy/Caddyfile.chess; } \
        | sudo tee /etc/caddy/Caddyfile.new >/dev/null
    sudo caddy validate --config /etc/caddy/Caddyfile.new --adapter caddyfile --envfile /etc/caddy/env \
        && sudo mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile \
        && sudo systemctl reload caddy

Never write into `/etc/caddy/Caddyfile` before validating. That file is already
serving other sites, so a malformed or unsubstituted block written straight into it
breaks all of them and stays broken until it is hand-edited back out. The candidate is
a separate file until it validates, and the three commands are chained with `&&` on
purpose: pasting the whole block at once must not be able to install a config that
failed the check. The dated backup is the one-command way back if a reload still
misbehaves. If validation fails, fix the render and re-run; delete the leftover
`/etc/caddy/Caddyfile.new` when you are done with it.

Two details in that sequence are load-bearing. The bare `echo` between the two parts
guards against a live file with no trailing newline, which would otherwise glue its
final `}` onto the new site address. And the candidate is built in `/etc/caddy/`
rather than `/tmp` because Caddyfile `import` paths resolve relative to the directory
of the config file being read — if the existing sites use a relative `import`,
validating a copy from `/tmp` would not resolve the same files. `--adapter caddyfile`
is passed explicitly so the check never depends on filename inference.

`deploy/Caddyfile.chess` is gitignored, so the rendered file survives `git pull`
without dirtying the clone.

The Cloudflare token lives in `/etc/caddy/env`; without `--envfile` the validate step
fails on the existing sites too. Requires a DNS A record `<domain> -> <tailnet-ip>`.

Port 8090 is published on loopback only (`127.0.0.1:8090:8090`) and must stay that
way. The app's cross-site guard reads fetch-metadata headers, which browsers send
only to trustworthy origins — that is, through Caddy's TLS. A plain-HTTP request
straight to `<host>:8090` carries no such header and bypasses the guard. After
deploying, confirm from another machine that
`curl --max-time 5 http://<tailnet-ip>:8090/api/health` fails to connect.
