# Permanent shared strategies

The application uses one team-wide strategy library. Visitors do not need to
choose a draft room to view or edit it. Everyone with the application link can
collaborate; this change does not add accounts or restrict editors.

## Production setup

1. Create or select a PostgreSQL database in Neon, Render, or an existing provider.
2. Add its connection string to the Render web service's **DATABASE_URL** secret.
   Use the provider's TLS-enabled connection string. Never put this secret in Git.
3. Set **REQUIRE_DURABLE_STRATEGIES=1**. This is also the default when Render's
   `RENDER=true` environment variable is present.
4. Deploy this branch. The application creates its tables automatically on the
   first request. The database user needs permission to create those tables.
5. Confirm the library banner says **Saved on server · shared with everyone**.
   Open the site in a second browser profile, change a ranking, and confirm it
   arrives in the other browser. Restart the web service and verify it remains.

The Render web service can stay on its existing plan when an external PostgreSQL
database is used. Database pricing and account limits belong to the provider;
no paid resources are provisioned by this change.

Do not merge/deploy before configuring the database. If the database is missing
or unreachable, editing stays unavailable and local saved libraries are preserved.
The application does not fall back to temporary production storage.

## Preserve existing strategies

On the first shared-library visit, an existing browser library is backed up in
that browser. A legacy room library is also offered when available. Click
**Add my saved versions** to merge those versions into the shared library.
Existing shared versions are retained. Import uses the same non-destructive
merge; ID collisions with different contents create additional copies.

Changes automatically appear in other browsers about every two seconds.
Editing different categories merges independently. If two people change the
same ranking, the second editor can export their unsaved work or explicitly
load the latest shared copy. Unsaved work also survives a browser reload as
an offered backup. A server history snapshot is kept for every successful write.

Draft rooms still hold their individual picks, bans, map and pinned version.
Their current JSON store is separate from the permanent strategy database.

## Local development and checks

Without `DATABASE_URL`, local development uses `shared-strategies.sqlite3`.
Set `STRATEGY_DB_PATH` to choose a different local database path. SQLite files
are excluded from Git. SQLite is only durable in deployment if its path is on
an actual persistent volume and `STRATEGY_STORAGE_DURABLE=1` is explicitly set.

Run `python shared_store_test.py` for transaction, merge, conflict, history,
lock and fresh-process tests. PostgreSQL integration runs only against the
explicit disposable `TEST_DATABASE_URL`; it never uses production `DATABASE_URL`.
The `shared-strategy` GitHub workflow provisions disposable PostgreSQL and
two isolated browser sessions. Browser tests start their own local server and
test restart persistence; they never write to the public strategy library.
