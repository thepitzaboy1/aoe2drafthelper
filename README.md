# AoE2 Draft Assistant v3

A shared Age of Empires II tournament drafting assistant built around **your team's strategy**, not a generic S/A/B/C tier list.

## v3 highlights

### Versioned strategy builder

The strategy builder now keeps immutable-ish history instead of one constantly changing list.

Each version stores:

- category definitions (Flank, Halb + SO, Paladin, Pocket, Cav Archer, or anything custom)
- civilization order inside every category
- map-specific overrides
- description / tournament notes
- created time and parent/source version
- lock state

You can:

- create a new version from the current version
- rename and describe versions
- lock a tournament-ready version
- switch to older versions
- **Restore as new** to branch from an old version without destroying history
- delete unwanted versions

A live draft is **pinned to a specific strategy version**, so editing a future version does not silently change the recommendations in an active match.

### Map-specific rankings

Base rankings remain the default. In Strategy Builder, choose a map such as:

- Arabia
- Arena
- Black Forest
- Rage Forest
- Michi
- Fortress
- Hideout
- Nomad
- Four Lakes
- Socotra
- Golden Pit
- MegaRandom

When you edit a category while a map is selected, the app automatically creates a map-specific override for that category. Categories without an override continue inheriting the base ranking.

Example:

- Base Halb + SO: Bohemians → Celts → Teutons → Slavs
- Black Forest override: Bohemians → Celts → Slavs → Teutons

### Map intelligence and recommendation score

For a selected map the live-draft screen combines six signals:

- **45% Team preference** — your order inside the selected capability categories
- **15% Map signal** — public map win-rate data when available, blended with a map-style profile
- **15% Composition coverage** — how much of the selected team need the civ solves
- **10% Flexibility** — number of useful categories the civ covers
- **10% Scarcity** — urgency when preferred options are disappearing
- **5% Opponent denial** — overlap with capabilities marked as opponent threats

The exact public statistic is intentionally a secondary signal. Public sources are usually 1v1 Random Map data, while tournament drafts (especially Rage Forest / 4v4) are coordinated team games.

### Public map statistics

The server attempts to retrieve the selected map's **1v1 RM map-performance table from AoE2 Ladder** and shows the source/freshness in the UI.

- Results are cached for 15 minutes.
- Arabia and Arena include a small seeded fallback snapshot so recommendations still demonstrate the statistic layer if the upstream page is temporarily inaccessible.
- Rage Forest intentionally uses the team's map model rather than pretending that 1v1 data is directly representative.
- If stats cannot be fetched, recommendations continue using your rankings, composition, scarcity and map profile and are clearly labelled as **Team model only**.

### Scarcity warnings

For each capability selected under **Our needs**, the app watches your top five choices.

Example warning:

> Halb + SO at risk: only 2/5 preferred options remain. Best available: Slavs.

This is designed to answer the live-draft question: **what do we need to secure before the next pick cycle?**

## Core workflow

1. Open **Strategy Builder**.
2. Build categories and drag civilizations left → right from strongest to weakest.
3. Create a named version for the tournament / practice session.
4. Add map-specific overrides only where your order changes.
5. Lock a tournament-ready version.
6. Open **Live Draft** and pin the version you want to use.
7. Select the map.
8. Select your remaining capabilities under **Our needs**.
9. Select likely opponent requirements under **Opponent threats**.
10. Use **Best next pick**, **Best ban**, **Map Intelligence**, and the **Capability Matrix** while the draft progresses.
11. Click each civilization to cycle Available → Our pick → Their pick → Banned when automatic AoE2CM live-state data is unavailable.

## Shared team room

Choose a room name and click **Join**, then **Copy link**. Teammates using the same hosted app + room link share:

- strategy versions
- map overrides
- pinned draft version
- picks / bans
- selected needs / threats
- selected map

Room state currently uses a simple server-side JSON store and browser local storage. On a free/ephemeral host, server restarts can clear server-side room state; each browser still retains its most recent local copy. A database such as Supabase is the natural next persistence upgrade.

## AoE2CM

The app attempts:

`GET https://aoe2cm.net/api/draft/<draft-id>`

When the live draft is not exposed through that endpoint, the manual shared board remains fully functional.

## Hosting on Render

The repository includes `render.yaml` and uses only the Python standard library.

Render start command:

```bash
python server.py --no-browser
```

The server reads the platform-provided `PORT` environment variable automatically.

## Local Windows start

Double-click `run.bat`, or run:

```bash
python server.py
```

Then open `http://127.0.0.1:8765`.

## Strategy backup

**Export** creates JSON containing the entire strategy library — all versions, categories and map overrides — but intentionally does not include the current room's live draft marks.
