# AoE2 Draft Assistant v2

Category-first team drafting for Age of Empires II.

## What changed from v1

Instead of a single S/A/B/C tier list, v2 lets your team define tactical categories:

- Flank civ
- Halb + SO
- Paladin
- Pocket
- Cav Archer
- Camel
- Gunpowder
- Siege
- Boom
- Anti-cav
- Player comfort categories
- any custom category you want

A civilization can belong to multiple categories and can have a different rank inside each category.

## Live draft workflow

1. Build your categories before the tournament.
2. Drag civs into each category in preference order (left = strongest).
3. Open **Live Draft**.
4. Select the capabilities you still need under **Our needs**.
5. Optionally select categories you think the opponent needs under **Opponent threats**.
6. The app recommends:
   - best next pick
   - best ban
   - flexible civs that cover multiple categories
7. Click civ cards as the draft progresses:
   - Available
   - Our pick
   - Their pick
   - Banned
8. The capability matrix shows what your composition has already secured.

The AoE2CM URL sync is still included. If AoE2CM does not expose live action data for an in-progress draft, the shared manual board keeps working.

## Shared team room

The app includes a tiny server-side shared room store.

Choose a room name, click **Join**, then **Copy link**. Everyone using the same hosted app + room link sees the same:

- category setup
- rankings
- picks / bans
- selected needs / threats

Room state polls every ~2 seconds.

## Local Windows start

1. Unzip.
2. Double-click `run.bat`.
3. Open `http://127.0.0.1:8765`.
4. Teammates on the same LAN can use `http://YOUR-PC-IP:8765`.

No third-party Python packages are required.

## Host on the internet

This package is ready for a small Python web host.

### Render

Files included:
- `render.yaml`
- `requirements.txt` (empty because the app uses only the standard library)

Typical deployment:
1. Put this folder in a GitHub repo.
2. Create a Render Web Service from the repo.
3. Render will use the `render.yaml` configuration.
4. Share the public URL with your team.

### Docker / Railway / Fly / Azure

A `Dockerfile` is included. Any platform that can run a container can host it.

The server reads the `PORT` environment variable automatically.

## Security note

This is a team utility with no authentication. Anyone who knows a room link can read/update that room. Use a hard-to-guess room name and do not expose sensitive information in it.

## Strategy backup

The **Export** button produces JSON containing all categories, civs and rankings. The **Import** button restores it.

This is useful if you want different tournament-specific strategy packs.
