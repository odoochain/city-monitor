# Migrate weather forecast to BrightSky for German cities

- **Date**: 2026-05-01
- **Status**: completed
- **Type**: feature

## Problem

Production weather is intermittently 5+ days stale because Render's egress IP shares Open-Meteo's per-IP daily quota (10k/day) with other tenants and we get 429s. Lowering our cadence further can't fix it — we're not the cause.

## Approach

For German cities (today: Berlin, Hamburg) replace the Open-Meteo forecast call with [BrightSky](https://brightsky.dev) — a free, account-key-free wrapper around DWD's official observations + MOSMIX forecast. No IP rate limiting; goes straight to the source DWD uses for German weather. For any future non-German city, log a warning and skip — don't fail the whole cron — until a WeatherAPI.com (or other) adapter is implemented.

Out of scope per user direction: air-quality stays on `air-quality-api.open-meteo.com`, DWD UV stays direct, DWD alerts stay direct (BrightSky `/alerts` would simplify but doubles PR scope; deferred). The shared `WeatherData` shape stays compatible with the existing Zod schema.

### Routing & config

Route on `city.dataSources.weather.provider`, not `country`. Reasons:
- The literal type `provider: 'open-meteo'` in `shared/types.ts:60` is currently a lying historical name (we're switching off Open-Meteo). Fix it now while we're touching this code.
- `country`-routing is fine for DWD alerts/UV (those *are* country-specific) but conflates "country" with "provider" for forecast.
- Self-documenting at the config site, mirroring the existing `transit: { provider: 'hafas' }` pattern.

Provider unknown to the orchestrator → log warn + skip city, *not* throw. The current per-city loop aggregates failures and re-throws on any error — if we threw for a non-DE city, every cron run would mark `lastFailure` for ALL cities, including the working DE ones. Skipping is the correct shape.

### Three real adapter decisions worked through in research

1. **WMO weather code** — BrightSky uses string `icon` ("clear-day", "rain", "thunderstorm", etc.). Frontend's `weather-codes.ts` lookup is keyed on WMO numbers. Map BrightSky's ~12-value icon enum to representative WMO codes inside the adapter; frontend doesn't change. Pure lookup table.
2. **Daily aggregates** — BrightSky has no daily-rollup endpoint. Roll up hourlies in `Europe/Berlin` (or `city.timezone`) local-day buckets: `high = max(temp)`, `low = min(temp)`, `precip = sum(precipitation)`, `weatherCode = icon at the entry closest to 12:00 local on that day`.
3. **Sunrise/sunset** — Not in BrightSky. Add `suncalc` (MIT, ~5KB, 7M weekly downloads, zero transitive deps). Inlining astronomical formula = 30+ lines of fiddly edge cases for negligible gain. Output as `.toISOString()` (UTC with Z suffix).

### Field gaps after migration

| Field | Today | Post-migration |
|---|---|---|
| `current.feelsLike` (Zod required) | Open-Meteo `apparent_temperature` | **Steadman apparent-temp formula** computed from temp/humidity/wind (~5 lines) |
| `current.uvIndex`, `uvIndexClearSky` (optional) | Open-Meteo | **Omitted** (was always optional; `data.dwdUv` 3-day forecast still populated by separate DWD UV call) |
| `hourly[].precipProb` (Zod required) | Open-Meteo | **`precipitation_probability ?? 0`** (BrightSky returns null for past observations and sometimes near-term forecasts) |
| `hourly[].uvIndex` (optional) | Open-Meteo per-hour | **Omitted** |
| `daily[].uvIndexMax`, `uvIndexClearSkyMax` (optional) | Open-Meteo | **Omitted** |
| `daily[].sunrise`, `sunset` (Zod required) | Open-Meteo local time string | **suncalc, `.toISOString()` UTC** — format change, frontend doesn't currently render these so display impact zero |

### Hourly array length

BrightSky's `/weather?date=today&last_date=today+6` returns observations for past hours of today + forecast for the rest, so the array is `>168` (typically 168 + N where N = hours elapsed today UTC). Open-Meteo's `forecast_days=7` does the same — past hours of today are included today. Frontend (`WeatherStrip.tsx:29`) filters `time >= now`, so behavior is identical. Existing test assertions like `toHaveLength(3)` work in synthetic mocks (we control the array length); no test logic change beyond updating mock data shape.

### Snapshot type stays `'open-meteo'`

Postgres `snapshots.type = 'open-meteo'` is an opaque retention/freshness key referenced at six sites:
- `packages/server/src/db/schema.ts` — pgEnum value
- `packages/server/src/db/reads.ts:104` — `loadWeather`
- `packages/server/src/db/reads.ts` — `loadWeatherHistory`
- `packages/server/src/db/writes.ts` — `saveWeather`
- `packages/server/src/app.ts:110` — startup freshness filter
- `packages/server/src/cron/data-retention.ts` — retention enum

Renaming requires a Drizzle migration + DB-side rename of existing rows (3-day retention so data loss is small but real). Out of scope here. Leave a single comment near `saveWeather` in `ingest-weather.ts` noting the historical name. Rename is a follow-up.

### Alternatives considered

- *Buy Open-Meteo customer key.* Smallest diff, unknown pricing. Rejected — BrightSky is free and uses better data for German cities.
- *WeatherAPI.com today.* Global, account-keyed. Rejected because BrightSky is strictly better for DE; documented as the next-step adapter when a non-DE city is added.
- *Inline adapter in `ingest-weather.ts`.* Would push 285 → ~440 lines and conflate orchestration with provider specifics. The `lib/` adapter pattern (`rss-parser.ts`, `openai.ts`, `geocode.ts`) is established. Plan extracts.
- *Migrate DWD alerts to BrightSky `/alerts` at the same time.* Tempting (cleaner JSON vs current JSONP regex), but doubles PR scope. Acknowledged inconsistency: `fetchDwdAlerts` and `fetchDwdUv` stay inline in `ingest-weather.ts` while BrightSky moves to `lib/`. Documented as a follow-up target.

## Changes

| File | Change |
|------|--------|
| `shared/types.ts` | Widen `CityDataSources.weather.provider` from `'open-meteo'` to `'open-meteo' \| 'brightsky'`. |
| `packages/server/src/config/cities/berlin.ts` | `dataSources.weather.provider` `'open-meteo'` → `'brightsky'`. |
| `packages/server/src/config/cities/hamburg.ts` | Same. |
| `packages/server/src/config/index.test.ts` (or `config.test.ts`) | Update assertions that expect `provider === 'open-meteo'` for Berlin/Hamburg → `'brightsky'`. |
| `packages/server/src/lib/brightsky.ts` | NEW. Adapter exporting `fetchBrightSkyForecast(city: CityConfig): Promise<WeatherData>`. Calls `/current_weather` (uses `wind_speed_10` for 10-min avg, the best near-current parity with Open-Meteo) + `/weather?date=&last_date=` (7-day range). Internal helpers: `iconToWmoCode(icon: string): number` (lookup table, throws on unknown icon to surface BrightSky enum changes), `apparentTemp(temp, humidity, windKmh): number` (Steadman formula), `rollUpDaily(hourly, lat, lon, timezone): DailyForecast[]` (groups by local date via `Intl.DateTimeFormat`, computes high/low/precip-sum, picks 12:00-local entry's icon, suncalc for sunrise/sunset). Throws on non-OK with `BrightSky <endpoint> ${status} for ${city.id}: ${body.slice(0,200)}`. |
| `packages/server/src/lib/brightsky.test.ts` | NEW. Tests listed below. |
| `packages/server/src/cron/ingest-weather.ts` | Replace Open-Meteo forecast block with provider dispatch: `if (provider === 'brightsky') data = await fetchBrightSkyForecast(city); else { log.warn(...); continue }` (the `continue` is in the loop, not in `ingestCityWeather`). Move the provider check to the top of the loop in `createWeatherIngestion` so unsupported providers don't even enter `ingestCityWeather`, and the per-city aggregator never sees them as a failure. Keep DWD alerts call (still populates `data.alerts` by mutation, same as today). Keep DWD UV call. Keep cache-set + DB-save + air-quality call exactly as today. Delete: Open-Meteo forecast URL constant, `OpenMeteoResponse` interface, `transformWeatherData`. Add a one-line comment near `saveWeather` noting `'open-meteo'` snapshot type is historical. |
| `packages/server/src/cron/ingest-weather.test.ts` | Update existing tests: stub BrightSky responses (two endpoints per city: `/current_weather` and `/weather`); URL discriminator: `url.includes('/current_weather') \|\| url.includes('/weather?')` for BrightSky vs DWD/AQ; for multi-city, additionally key on `lat=52.52` for Berlin. Remove `uvIndex`/`uvIndexClearSky` assertions from the `toEqual(data.current)` test. Update sunrise/sunset assertions to match-any-ISO regex (`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/`) since BrightSky+suncalc emits UTC ISO-8601 not local-time strings. NEW test: "skips city with no adapter" — use `vi.spyOn` on `getActiveCities` to return a stub config with `provider: 'open-meteo'`, assert: ingest does NOT throw, the unsupported city has no cache entry, a warn was logged. |
| `packages/server/src/scripts/check-weather-sources.ts` | Replace the `Open-Meteo forecast` probe with three BrightSky probes: `BrightSky current_weather`, `BrightSky weather (7-day range)`, `BrightSky alerts`. Keep `Open-Meteo air-quality`, `DWD warnings`, `DWD UV` probes unchanged. Exit-1-on-any-failure logic unchanged. |
| `packages/server/package.json` | Add `"suncalc": "^1.9.0"` to dependencies, `"@types/suncalc": "^1.9.2"` to devDependencies. |
| `.context/weather.md` | Rewrite. Sections: Data Flow (BrightSky for DE), Data Sources (BrightSky + DWD UV + Open-Meteo air-quality), Key Types (note `feelsLike` is computed via Steadman in the adapter; UV per-hour/per-day no longer populated, dashboard's UV widget reads `data.dwdUv` instead), DB Schema (snapshot type `'open-meteo'` is historical), Diagnostics (`npm run check:weather`), **Adding a non-German city** (point at WeatherAPI.com — 100k/mo free, account-keyed, global; sketch what an adapter file would look like + that it should be selected via `provider` in the city config). |

## Tests

Logic-bearing tests in `packages/server/src/lib/brightsky.test.ts`:

1. **Icon → WMO code mapping** — for every BrightSky icon value (clear-day/night, partly-cloudy-day/night, cloudy, fog, wind, rain, snow, sleet, hail, thunderstorm), assert it maps to a WMO code in the set `weather-codes.ts` recognizes. One synthetic icon ("not-a-real-icon") asserts the lookup throws — surfaces BrightSky enum changes.
2. **Daily rollup** — given a synthetic 7-day hourly array (168 entries) with deterministic temps and precip per hour, assert: 7 daily entries; `high`/`low`/`precip` correct per day; `weatherCode` matches the icon of the 12:00-local entry per day; entries grouped by `Europe/Berlin` local date (so a synthetic 23:00Z entry on day N is in day N+1's bucket if Berlin is at +1).
3. **Sunrise/sunset wiring** — assert each daily entry has `sunrise`/`sunset` ISO strings ending in `Z` (UTC). Don't assert exact times — suncalc is a black-box dep.
4. **Apparent-temperature formula** — three sample inputs (cold-windy, warm-humid, neutral) with expected outputs computed offline; assert the helper returns within 0.1°C.
5. **Null `precipitation_probability` coercion** — stub a BrightSky hourly entry with `precipitation_probability: null`; assert the resulting `precipProb` is `0`.
6. **Throw on non-OK** — stub `fetch` returning `{ ok: false, status: 503 }`; assert the adapter throws with `503` in the message.

Updates in `packages/server/src/cron/ingest-weather.test.ts`:

7. **Existing happy-path test** — swap mock from Open-Meteo to BrightSky responses (two URLs per city). Assert cache contains a `WeatherData` with the required Zod fields populated; UV fields can be undefined.
8. **Existing non-OK test** — assertion stays "throws with status in message"; only mock URL/response changes.
9. **Existing multi-city aggregation** — same behavior; mock keyed off BrightSky paths + `lat=52.52` for Berlin.
10. **NEW: skips unsupported provider** — use `vi.spyOn(configModule, 'getActiveCities').mockReturnValue([berlinStub, fakeNonDe])` where `fakeNonDe` has `provider: 'open-meteo'`. Assert: ingest does NOT reject (Berlin succeeds), `cache.get('berlin:weather')` is populated, `cache.get('fakeNonDe:weather')` is null, a warn line was logged.

No tests for: WMO mapping table values themselves (covered by Test 1's "all map to known codes"), URL strings or output formatting in `check-weather-sources.ts`, prompt/copy/config — all static content.

## Out of Scope

- Migrating air-quality off `air-quality-api.open-meteo.com` (still works; separate decision).
- Migrating DWD alerts to BrightSky `/alerts` (deferred; would replace JSONP-regex with cleaner JSON; acknowledged asymmetry that `fetchDwdAlerts`/`fetchDwdUv` stay inline while BrightSky moves to `lib/`).
- Implementing the WeatherAPI.com adapter (only documented).
- Renaming the `'open-meteo'` Postgres snapshot type (would require Drizzle migration touching 6 reference sites + existing rows).
- Frontend changes — `WeatherData` Zod schema preserved.
- Removing `WEATHER_TIMEOUT_MS` constant or other surrounding cleanup in `ingest-weather.ts`.
- Bringing back per-hour/per-day UV (was Open-Meteo-only; we don't have an alternative source). The DWD UV 3-day daily-summary remains via the separate `fetchDwdUv` path.
