# ExcaliDash disaster restore and upgrade recovery

This runbook is for the single-VPS SQLite deployment in
`docker-compose.prod.yml`. A server backup contains `database.sqlite`, all
referenced files below `assets/originals/`, and the persisted `.jwt_secret` and
`.csrf_secret`. It does **not** contain the Compose `.env`, TLS/reverse-proxy
configuration, or external OIDC/SMTP credentials; keep those encrypted beside
the off-site backup.

Commands below assume a clean `/opt/excalidash` directory. Run one numbered
step at a time and stop when its expected result is not true.

## Restore after loss of the server or disk

1. Install Docker Engine with the Compose v2 plugin on the replacement host.
   Create `/opt/excalidash` and `/srv/excalidash-backups`, then copy the saved
   `docker-compose.prod.yml`, production `.env`, backup ZIP, and its `.sha256`
   file into `/opt/excalidash`.

   ```bash
   sudo install -d -m 700 /opt/excalidash /srv/excalidash-backups
   cd /opt/excalidash
   docker version
   docker compose version
   ```

   **Expected result:** both version commands succeed and the two directories
   exist with access restricted to the administrator.

2. Verify that the off-site copy arrived intact. Replace the example filename
   with the selected archive in both commands.

   ```bash
   sha256sum -c excalidash-backup-2026-08-20T03-00-00-000Z.zip.sha256
   unzip -t excalidash-backup-2026-08-20T03-00-00-000Z.zip
   ```

   **Expected result:** `sha256sum` prints `OK`, and `unzip` reports no errors.
   Do not restore an archive that fails either check.

3. Inspect the manifest and contents before extraction.

   ```bash
   unzip -p excalidash-backup-2026-08-20T03-00-00-000Z.zip backup.manifest.json
   unzip -l excalidash-backup-2026-08-20T03-00-00-000Z.zip
   ```

   **Expected result:** the manifest says `excalidash-server-backup`; the list
   contains `database.sqlite`, `assets/originals/...` when documents exist, and
   normally `secrets/.jwt_secret` plus `secrets/.csrf_secret`. Missing secret
   files are acceptable only when the production `.env` contains the exact
   original `JWT_SECRET` and `CSRF_SECRET` values.

4. Restore the saved production configuration. Its `EXCALIDASH_IMAGE_TAG` must
   be the exact release or `sha-...` tag that created the backup, and
   `BACKUP_HOST_DIR` must be an absolute host path.

   ```bash
   chmod 600 .env
   grep -E '^(EXCALIDASH_IMAGE_TAG|BACKUP_HOST_DIR|FRONTEND_URL|AUTH_MODE)=' .env
   docker compose -f docker-compose.prod.yml config --images
   ```

   **Expected result:** two immutable image references with the same non-latest
   tag are printed. `BACKUP_HOST_DIR` points at a directory included in an
   off-site replication or provider-snapshot job.

5. Pull the pinned images and create, but do not start, the containers and data
   volume.

   ```bash
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml create
   docker compose -f docker-compose.prod.yml ps --all
   ```

   **Expected result:** both containers have state `Created`; the backend has
   not run migrations against an empty database.

6. Extract into a new directory and resolve the actual backend volume name.

   ```bash
   mkdir restore
   unzip excalidash-backup-2026-08-20T03-00-00-000Z.zip -d restore
   BACKEND_VOLUME="$(docker inspect excalidash-backend --format '{{range .Mounts}}{{if eq .Destination "/app/prisma"}}{{.Name}}{{end}}{{end}}')"
   test -n "$BACKEND_VOLUME"
   ```

   **Expected result:** `restore/database.sqlite` exists and `BACKEND_VOLUME`
   is non-empty.

7. Copy the database, originals, and secrets into the empty volume. The numeric
   owner `1001` is the backend user from the pinned image.

   ```bash
   docker run --rm \
     -v "$BACKEND_VOLUME:/target" \
     -v "$PWD/restore:/restore:ro" \
     alpine:3.20 sh -ec '
       test ! -e /target/dev.db
       cp /restore/database.sqlite /target/dev.db
       mkdir -p /target/assets/originals
       if [ -d /restore/assets/originals ]; then cp -a /restore/assets/originals/. /target/assets/originals/; fi
       if [ -f /restore/secrets/.jwt_secret ]; then cp /restore/secrets/.jwt_secret /target/.jwt_secret; fi
       if [ -f /restore/secrets/.csrf_secret ]; then cp /restore/secrets/.csrf_secret /target/.csrf_secret; fi
       chown -R 1001:1001 /target
       chmod 600 /target/dev.db
       [ ! -f /target/.jwt_secret ] || chmod 600 /target/.jwt_secret
       [ ! -f /target/.csrf_secret ] || chmod 600 /target/.csrf_secret
     '
   ```

   **Expected result:** the command exits with status 0. If `/target/dev.db`
   already existed, it exits before overwriting anything; investigate instead
   of deleting it blindly.

8. Check SQLite integrity before migrations or application startup.

   ```bash
   docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint node backend -e '
     const D=require("better-sqlite3");
     const db=new D("/app/prisma/dev.db",{readonly:true,fileMustExist:true});
     const rows=db.pragma("integrity_check");
     console.log(rows);
     if(rows.length!==1 || rows[0].integrity_check!=="ok") process.exit(1);
   '
   ```

   **Expected result:** the output contains `{ integrity_check: 'ok' }` and the
   command exits with status 0.

9. Start only the backend. Its entrypoint applies migrations belonging to the
   pinned image, then wait for the operational HTTP probe.

   ```bash
   docker compose -f docker-compose.prod.yml up -d backend
   docker compose -f docker-compose.prod.yml logs backend --tail=200
   docker compose -f docker-compose.prod.yml exec backend node -e '
     require("http").get("http://127.0.0.1:8000/health",r=>process.exit(r.statusCode===200?0:1)).on("error",()=>process.exit(1))
   '
   docker inspect excalidash-backend --format '{{json .State.Health}}'
   ```

   **Expected result:** logs show successful migrations and server startup; the
   backend container becomes `healthy`. If not, leave the frontend stopped and
   follow the interrupted-upgrade procedure below.

10. Start the frontend and verify application data, not just HTTP status.

    ```bash
    docker compose -f docker-compose.prod.yml up -d frontend
    docker compose -f docker-compose.prod.yml ps
    ```

    **Expected result:** both containers become `healthy`. Sign in, open one
    known drawing and one restored PDF, and confirm users/roles and sharing on
    a second known drawing.

11. Copy the verified archive into `BACKUP_HOST_DIR`, restart the normal
    off-site replication job, and create a fresh checksum.

    ```bash
    cp excalidash-backup-2026-08-20T03-00-00-000Z.zip /srv/excalidash-backups/
    sha256sum /srv/excalidash-backups/excalidash-backup-2026-08-20T03-00-00-000Z.zip
    ```

    **Expected result:** the archive exists locally and the replication target
    reports a second copy outside this VPS.

## Safe upgrade and rollback

1. Record the current immutable tag and create an immediate full backup while
   the existing backend is healthy.

   The backend image stays root by design so its entrypoint can fix volume
   permissions at boot (see `backend/Dockerfile`); `docker compose exec`
   without `--user nodejs` therefore runs as root and writes a backup the
   scheduled job's own readiness check cannot read back (`/ready` reports
   `"backup":"unavailable"` even though the archive is valid). Always pass
   `--user nodejs`.

   ```bash
   cd /opt/excalidash
   grep '^EXCALIDASH_IMAGE_TAG=' .env
   docker compose -f docker-compose.prod.yml exec --user nodejs backend node dist/backups/runOnce.js
   BACKUP_DIR="$(grep '^BACKUP_HOST_DIR=' .env | cut -d= -f2-)"
   LATEST_BACKUP="$(ls -1t "$BACKUP_DIR"/excalidash-backup-*.zip | head -1)"
   sha256sum "$LATEST_BACKUP" > "$LATEST_BACKUP.sha256"
   ```

   **Expected result:** the command prints `One-off backup completed`; a new ZIP
   and matching `.sha256` exist, and their off-site copy finishes before the
   upgrade continues.

2. Change `EXCALIDASH_IMAGE_TAG` in `.env` to the reviewed release or SHA, pull,
   and recreate. Never use `latest`.

   ```bash
   docker compose -f docker-compose.prod.yml pull
   docker compose -f docker-compose.prod.yml up -d
   docker compose -f docker-compose.prod.yml ps
   ```

   **Expected result:** both services become `healthy`. Preserve the old tag
   and the exact pre-upgrade backup until application checks pass.

3. If the backend repeatedly reports a migration-lock timeout, stop it and
   prove no migration container is running before removing a stale directory.

   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   docker ps --filter label=com.docker.compose.project --format '{{.Names}} {{.Status}}'
   BACKEND_VOLUME="$(docker inspect excalidash-backend --format '{{range .Mounts}}{{if eq .Destination "/app/prisma"}}{{.Name}}{{end}}{{end}}')"
   docker run --rm -v "$BACKEND_VOLUME:/target" alpine:3.20 sh -ec 'test -d /target/.migration-lock && rmdir /target/.migration-lock'
   docker compose -f docker-compose.prod.yml up -d backend
   ```

   **Expected result:** the lock directory is removed only after the backend is
   stopped; the next startup no longer times out on `.migration-lock`. If the
   directory is not empty or reappears, stop and diagnose rather than forcing
   deletion.

4. If Prisma reports a failed migration, keep the backend stopped and inspect
   status with the same pinned new image.

   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint npx backend prisma migrate status --schema=/app/prisma/schema.prisma
   ```

   **Expected result:** Prisma names the failed migration. Use `prisma migrate
   resolve --applied <name>` only when manual inspection proves every statement
   completed; use `prisma migrate resolve --rolled-back <name>` only after the
   migration's changes were actually reversed. Guessing here can corrupt the
   recovery point.

5. The reliable rollback after a partial or uncertain migration is a complete
   restore, not merely starting the old image. Set the old tag in `.env`, remove
   the failed containers and newly created volume only after recording their
   names, then repeat restore steps 5–10 with the pre-upgrade archive.

   **Expected result:** database, `assets/originals`, `.jwt_secret`, and
   `.csrf_secret` all come from the same pre-upgrade archive, and the old pinned
   image becomes healthy. Starting old code against a possibly newer schema is
   explicitly not considered a rollback.
