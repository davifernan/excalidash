# What this fork adds

Tracks [ZimengXiong/ExcaliDash](https://github.com/ZimengXiong/ExcaliDash) and carries four changes that
are also open upstream as separate pull requests. `main` here is the running,
self-hostable combination of all of them.

| Upstream PR | What it does |
| --- | --- |
| [#247](https://github.com/ZimengXiong/ExcaliDash/pull/247) | Version history no longer fills the disk: snapshots are Brotli-compressed and freed pages are returned |
| [#248](https://github.com/ZimengXiong/ExcaliDash/pull/248) | Password reset links are actually delivered, by SMTP or Resend |
| [#249](https://github.com/ZimengXiong/ExcaliDash/pull/249) | Reveal toggle on password fields, live match feedback, opt-in longer sessions |
| [#250](https://github.com/ZimengXiong/ExcaliDash/pull/250) | The E2E job stops locking itself out with HTTP 429 |
| not upstream yet | Admin-created accounts can be invited by email instead of handing a password over by chat |
| not upstream yet | Agents authenticate with an API key: the websocket accepts them too, and an admin tab lists and revokes them |

## Hosting it

On a server, pull the images rather than building there. Every push to `main`
that passes the tests publishes `linux/amd64` images to GHCR, so the machine
running ExcaliDash needs no checkout, no toolchain and no build memory:

```bash
curl -O https://raw.githubusercontent.com/davifernan/ExcaliDash/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/davifernan/ExcaliDash/main/.env.production.example
cp .env.production.example .env   # replace FRONTEND_URL; also set JWT_SECRET and CSRF_SECRET
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
```

The images are public, so no registry login is needed. Both services read the
same required `EXCALIDASH_IMAGE_TAG` value from `.env`; production therefore
cannot silently follow a later `latest` build.

### Upgrade and rollback

Choose an upgrade only after its commit has passed the required review and
checks. Convert the first seven characters of that full commit SHA into a tag,
for example commit `54cdcc9...` becomes `sha-54cdcc9`. Before changing
production, verify that **both** images were published:

```bash
NEXT_TAG=sha-54cdcc9
docker manifest inspect "ghcr.io/davifernan/excalidash-backend:${NEXT_TAG}" >/dev/null
docker manifest inspect "ghcr.io/davifernan/excalidash-frontend:${NEXT_TAG}" >/dev/null
```

Record the current value from `.env` as the rollback tag. Replace
`EXCALIDASH_IMAGE_TAG` with `NEXT_TAG`, validate the resolved references, then
pull and recreate the containers:

```bash
grep '^EXCALIDASH_IMAGE_TAG=' .env
docker compose --env-file .env -f docker-compose.prod.yml config --images
docker compose --env-file .env -f docker-compose.prod.yml pull
docker compose --env-file .env -f docker-compose.prod.yml up -d
docker compose --env-file .env -f docker-compose.prod.yml ps
```

The `config --images` output must contain the same immutable tag twice and no
`latest`. If the new build fails, put the recorded previous tag back into
`.env`, rerun `pull` and `up -d`, and check `ps` again. No compose-file edit or
registry retag is needed for rollback.

Note that `docker-compose.prod.yml` points at **this fork's** images
(`ghcr.io/davifernan/excalidash-*`). Upstream's images carry none of the
features below, so pointing it elsewhere quietly downgrades the instance.

To build from source instead — for development, or to run a change that is not
on `main` yet:

```bash
git clone https://github.com/davifernan/ExcaliDash.git
cd ExcaliDash
cp backend/.env.example .env
docker compose up -d --build
```

The frontend is then on `http://localhost:6767`. Every setting below is optional and
read from `.env`; the defaults keep the upstream behaviour.

### Which build am I running?

Settings → Advanced shows the version and, underneath it, the build. A published
image says `production · <commit>`; that commit is also the immutable
`sha-<commit>` value used by `EXCALIDASH_IMAGE_TAG` in `.env`.

A build made from source shows `LOCAL DEVELOPMENT BUILD` in red. That is a
label, not a different kind of build — the Docker build is a production build
either way (minified frontend served by nginx, backend installed without dev
dependencies, `NODE_ENV=production`). The marker only says that the image did
not come from the pipeline and therefore cannot be traced back to a commit.

### Sending password reset emails

Without a transport the reset endpoint answers 503 instead of claiming a mail was
sent, and the reset page shows the admin-recovery instructions instead of a form.

```bash
ENABLE_PASSWORD_RESET=true
MAIL_FROM="ExcaliDash <noreply@your-domain.com>"

# either an SMTP server you already run
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=
SMTP_PASSWORD=

# or Resend
RESEND_API_KEY=re_...
```

`MAIL_TRANSPORT` (`smtp`, `resend` or `none`) forces one explicitly; leaving it unset
follows whatever is configured. With Resend, turn **off** click tracking for the
sending domain — it rewrites links, which is the last thing a reset link needs.

### Version history

Both default to on and only need setting to switch them off:

```bash
ENABLE_SNAPSHOT_COMPRESSION=true   # store snapshots compressed (~90 % smaller)
ENABLE_SNAPSHOT_VACUUM=true        # return freed database pages to the filesystem
```

### Agents

An agent is an API key belonging to a user, not an account of its own, so anything it
creates already belongs to that user and nothing has to be shared afterwards. Users create
keys under **Profile → API keys**; admins see and revoke every key under **Admin → Agents**.

Beyond the default scopes, a key can be granted `drawings:history` and `drawings:share`.
Both are opt-in: an ordinary key can neither read a drawing's history nor hand it to another
account.

### Session length

```bash
JWT_REFRESH_EXPIRES_IN_REMEMBERED=30d   # used only when "stay signed in" is ticked
```
