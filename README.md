## Shared strategy library (database setup required before deployment)

Every visitor now uses the same server strategy library, regardless of draft room.
Rankings, versions, notes, locks and map overrides save automatically and update
other browsers. Draft rooms keep independent match picks and bans.

Production requires `DATABASE_URL` pointing to PostgreSQL. The Render blueprint
sets `REQUIRE_DURABLE_STRATEGIES=1`, so an unconfigured deployment refuses strategy
writes instead of pretending temporary storage is permanent. Local development
uses SQLite, configurable with `STRATEGY_DB_PATH`.

Existing browser and legacy room strategies are offered through **Add my saved
versions**. Import adds versions without deleting the team's existing library.
Conflicts preserve unsaved work for export; independent category edits merge.
Each successful write also creates a server history snapshot.

See [deployment and migration instructions](SHARED_LIBRARY_SETUP.md).

---

# AoE2 Draft Assistant v3.1

A shared Age of Empires II tournament drafting assistant built around **your team's strategy**, not a generic S/A/B/C tier list.

## v3.1 highlights

### Rage Forest is now a first-class dataset

Rage Forest is the primary use case, so it no longer falls back to a generic closed-map heuristic.

The repository contains a checked-in dataset at:

`data/rage_forest_6_2026.json`

It is based on **Rage Forest 6**, a 2026 4v4 tournament played exclusively on Black Forest:

- 127 tournament games
- 53 civilizations represented in the statistics table
- wins, losses, raw win rate, and total civilization appearances
- source metadata stored with the dataset

The server exposes this through:

`GET /api/mapstats?map=Rage%20Forest`

For RF the app also computes a **sample-adjusted win rate** using a 12-appearance neutral prior. This stops tiny samples such as a civilization going 3-0 from automatically being treated as stronger evidence than a civilization played 20+ times.

In Strategy Builder, selecting **Rage Forest** now shows:

- your category rank
- RF raw win rate
- RF sample-adjusted rate
- tournament appearances
- map-fit score
- final map signal
- the top RF sample-adjusted civilization signals

For Live Draft recommendations, the RF tournament statistic gets more weight inside the map-signal component than generic map heuristics.

### Versioned strategy builder

Each version stores:

- category definitions (Flank, Halb + SO, Paladin, Pocket, Cav Archer, or anything custom)
- civilization order inside every category
- map-specific overrides
- description / tournament notes
- created time and parent/source version
- lock state

You can create a new version, rename/describe it, lock a tournament-ready version, restore an old version as a new branch, or delete unwanted versions.

A live draft is **pinned to a specific strategy version**, so editing a future version does not silently change the recommendations in an active match.

### Map-specific rankings

Base rankings remain the default. In Strategy Builder you can choose Arabia, Arena, Black Forest, Rage Forest, Michi, Fortress, Hideout, Nomad, Four Lakes, Socotra, Golden Pit, or MegaRandom.

When you edit a category while a map is selected, the app creates a map-specific override for that category. Categories without an override continue inheriting the base ranking.

### Map intelligence and recommendation score

For a selected map the live-draft screen combines six signals:

- **45% Team preference** — your order inside the selected capability categories
- **15% Map signal** — map statistics blended with a map-style profile
- **15% Composition coverage** — how much of the selected team need the civ solves
- **10% Flexibility** — number of useful categories the civ covers
- **10% Scarcity** — urgency when preferred options are disappearing
- **5% Opponent denial** — overlap with capabilities marked as opponent threats

For Rage Forest, the map-signal input uses the 4v4 RF tournament dataset. For other maps the server attempts to use public 1v1 RM map-performance data and falls back gracefully when unavailable.

### Scarcity warnings

For each capability selected under **Our needs**, the app watches your top five choices.

Example:

> Halb + SO at risk: only 2/5 preferred options remain. Best available: Slavs.

## Core workflow

1. Open **Strategy Builder**.
2. Build categories and drag civilizations left → right from strongest to weakest.
3. Create a named version for the tournament / practice session.
4. Select **Rage Forest** and review RF tournament stats while creating map-specific overrides.
5. Lock a tournament-ready version.
6. Open **Live Draft** and pin that version.
7. Select Rage Forest as the map.
8. Select your remaining capabilities under **Our needs**.
9. Select likely opponent requirements under **Opponent threats**.
10. Use **Best next pick**, **Best ban**, **Map Intelligence**, scarcity alerts, and the **Capability Matrix** while the draft progresses.
11. Click each civilization to cycle Available → Our pick → Their pick → Banned when automatic AoE2CM live-state data is unavailable.

## Shared team room

Choose a room name and click **Join**, then **Copy link**. Teammates using the same hosted app + room link share strategy versions, map overrides, the pinned draft version, picks/bans, selected needs/threats, and selected map.

Room state currently uses a simple server-side JSON store plus browser local storage. A database such as Supabase is the natural next persistence upgrade.

## AoE2CM

The app attempts:

`GET https://aoe2cm.net/api/draft/<draft-id>`

When the live draft is not exposed through that endpoint, the manual shared board remains fully functional.

## Hosting on Render

The repository includes `render.yaml` and uses only the Python standard library.

```bash
python server.py --no-browser
```

The server reads the platform-provided `PORT` environment variable automatically.

## Testing

GitHub Actions runs Python syntax checks, JavaScript syntax checks and an end-to-end smoke test. The smoke test specifically verifies the Rage Forest dataset endpoint, including the 127-game metadata and sample-adjusted values, then exercises the sample AoE2CM draft path.
