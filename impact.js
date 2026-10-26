// Proof of impact: how fast reports get fixed, where, and for whom.
// Every number here comes from Sidewalk's own reports plus free public data:
//   - U.S. Census geocoder: which census tract and county a pin is in.
//   - Census American Community Survey (ACS) 5-year estimates: median household income per tract and state.
//   - NHTSA Fatality Analysis Reporting System (FARS): fatal crashes by county, with locations.
// Lookups run as background jobs and are cached, so pages never wait on these services.

const DAY = 86_400_000;
const NEAR_METERS = 250;
const CRASH_CACHE_MS = 30 * DAY;
const ACS_YEAR = process.env.ACS_YEAR || '2023';
const FARS_TO_YEAR = Number(process.env.FARS_TO_YEAR) || new Date().getFullYear() - 2;
const FARS_YEARS = 5;
const USER_AGENT = 'Sidewalk community reporting app (student project)';

function metersBetween(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function getJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`);
  return response.json();
}

// Census geocoder: coordinates -> state, county, tract codes.
async function censusPlace(lat, lng) {
  const params = new URLSearchParams({ x: lng, y: lat, benchmark: 'Public_AR_Current', vintage: 'Current_Current', layers: 'Census Tracts', format: 'json' });
  const data = await getJson(`https://geocoding.geo.census.gov/geocoder/geographies/coordinates?${params}`);
  const geographies = data.result?.geographies || {};
  const key = Object.keys(geographies).find((name) => /tract/i.test(name));
  const tract = key && geographies[key][0];
  if (!tract?.STATE || !tract?.COUNTY || !tract?.TRACT) return null;
  return { state: tract.STATE, county: tract.COUNTY, tract: tract.TRACT, geoid: `${tract.STATE}${tract.COUNTY}${tract.TRACT}` };
}

// ACS median household income (table B19013). Negative values mean "not available".
// The Census data API needs a free key (api.census.gov/data/key_signup.html).
const censusKey = () => (process.env.CENSUS_API_KEY || '').trim();
async function acsIncome(forClause, inClause = '') {
  if (!censusKey()) throw new Error('CENSUS_API_KEY is not set, so income data is off');
  const params = new URLSearchParams({ get: 'B19013_001E', for: forClause, key: censusKey() });
  if (inClause) params.set('in', inClause);
  const response = await fetch(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5?${params}`, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  // A bad or missing key answers with a redirect to an HTML page, not JSON.
  if (response.headers.get('x-datawebapi-keyerror') || (response.status >= 300 && response.status < 400)) throw new Error('The Census API key was rejected. Check CENSUS_API_KEY');
  if (!response.ok) throw new Error(`api.census.gov answered ${response.status}`);
  const rows = await response.json();
  const value = Number(rows?.[1]?.[0]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// FARS fatal crashes for one county. The API wraps results as Results: [[...crashes]].
async function farsCrashes(state, county) {
  const params = new URLSearchParams({ fromCaseYear: FARS_TO_YEAR - FARS_YEARS + 1, toCaseYear: FARS_TO_YEAR, state: Number(state), county: Number(county), format: 'json' });
  // NHTSA serves the API under /crashviewer/CrashAPI; the older /CrashAPI path now returns a web page.
  let data;
  let lastError;
  for (const base of ['https://crashviewer.nhtsa.dot.gov/crashviewer/CrashAPI', 'https://crashviewer.nhtsa.dot.gov/CrashAPI']) {
    try {
      const response = await fetch(`${base}/crashes/GetCrashesByLocation?${params}`, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`NHTSA answered ${response.status}`);
      if (!/^\s*[{[]/.test(text)) throw new Error('NHTSA returned a web page instead of data');
      data = JSON.parse(text);
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!data) throw lastError;
  const list = Array.isArray(data.Results?.[0]) ? data.Results[0] : Array.isArray(data.Results) ? data.Results : [];
  if (list.length && !('LATITUDE' in list[0]) && !('Latitude' in list[0]) && !('latitude' in list[0])) {
    console.warn(`Impact: FARS records have no latitude field. Fields seen: ${Object.keys(list[0]).join(', ')}`);
  }
  return list
    .map((crash) => ({
      lat: Number(crash.LATITUDE ?? crash.Latitude ?? crash.latitude),
      lng: Number(crash.LONGITUD ?? crash.LONGITUDE ?? crash.Longitude ?? crash.longitude),
      year: Number(crash.CaseYear ?? crash.YEAR ?? crash.Year) || null,
      fatals: Number(crash.FATALS ?? crash.Fatals) || 1,
    }))
    // FARS uses codes like 77.7777 / 88.8888 / 99.9999 for "unknown"; keep only real Carolina coordinates.
    .filter((c) => c.lat > 30 && c.lat < 38 && c.lng > -86 && c.lng < -74);
}

function setupImpact({ db, jobs, router, serializeIssue }) {
  const cols = new Set(db.prepare('PRAGMA table_info(issues)').all().map((c) => c.name));
  for (const [name, type] of [['tract_geoid', 'TEXT'], ['county_fips', 'TEXT'], ['enriched_at', 'INTEGER'], ['enrich_failed_at', 'INTEGER'], ['nearby_fatal_crashes', 'INTEGER'], ['nearby_fatalities', 'INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE issues ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS tract_income (geoid TEXT PRIMARY KEY, median_income INTEGER, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS state_income (state TEXT PRIMARY KEY, median_income INTEGER, fetched_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS county_crashes (county_fips TEXT PRIMARY KEY, crashes TEXT NOT NULL, from_year INTEGER, to_year INTEGER, fetched_at INTEGER NOT NULL);
  `);

  async function ensureStateIncome(state) {
    if (db.prepare('SELECT 1 FROM state_income WHERE state = ?').get(state)) return;
    db.prepare('INSERT OR REPLACE INTO state_income (state, median_income, fetched_at) VALUES (?, ?, ?)').run(state, await acsIncome(`state:${state}`), Date.now());
  }

  async function ensureTractIncome(place) {
    if (db.prepare('SELECT 1 FROM tract_income WHERE geoid = ?').get(place.geoid)) return;
    const income = await acsIncome(`tract:${place.tract}`, `state:${place.state} county:${place.county}`);
    db.prepare('INSERT OR REPLACE INTO tract_income (geoid, median_income, fetched_at) VALUES (?, ?, ?)').run(place.geoid, income, Date.now());
  }

  async function countyCrashes(state, county) {
    const fips = `${state}${county}`;
    const cached = db.prepare('SELECT crashes, fetched_at FROM county_crashes WHERE county_fips = ?').get(fips);
    if (cached && Date.now() - cached.fetched_at < CRASH_CACHE_MS) return JSON.parse(cached.crashes);
    const crashes = await farsCrashes(state, county);
    console.log(`Impact: loaded ${crashes.length} fatal crash records for county ${fips} (${FARS_TO_YEAR - FARS_YEARS + 1}-${FARS_TO_YEAR}).`);
    db.prepare('INSERT OR REPLACE INTO county_crashes (county_fips, crashes, from_year, to_year, fetched_at) VALUES (?, ?, ?, ?, ?)')
      .run(fips, JSON.stringify(crashes), FARS_TO_YEAR - FARS_YEARS + 1, FARS_TO_YEAR, Date.now());
    return crashes;
  }

  async function enrichIssue({ id }) {
    const issue = db.prepare('SELECT id, lat, lng FROM issues WHERE id = ?').get(id);
    if (!issue) return;
    try {
      const place = await censusPlace(issue.lat, issue.lng);
      if (!place) {
        db.prepare('UPDATE issues SET enriched_at = ?, nearby_fatal_crashes = 0, nearby_fatalities = 0 WHERE id = ?').run(Date.now(), id);
        return;
      }
      // Income and crashes are independent; one failing shouldn't lose the other.
      const [stateIncome, tractIncome, crashes] = await Promise.allSettled([ensureStateIncome(place.state), ensureTractIncome(place), countyCrashes(place.state, place.county)]);
      const incomeError = [stateIncome, tractIncome].find((r) => r.status === 'rejected');
      if (incomeError && censusKey()) console.warn(`Income data unavailable for tract ${place.geoid}:`, incomeError.reason.message);
      const near = crashes.status === 'fulfilled' ? crashes.value.filter((c) => metersBetween(issue, c) <= NEAR_METERS) : null;
      db.prepare('UPDATE issues SET tract_geoid = ?, county_fips = ?, enriched_at = ?, nearby_fatal_crashes = ?, nearby_fatalities = ? WHERE id = ?')
        .run(place.geoid, `${place.state}${place.county}`, Date.now(), near ? near.length : null, near ? near.reduce((n, c) => n + c.fatals, 0) : null, id);
      if (crashes.status === 'rejected') console.warn(`Crash data unavailable for ${place.state}${place.county}:`, crashes.reason.message);
    } catch (error) {
      db.prepare('UPDATE issues SET enrich_failed_at = ? WHERE id = ?').run(Date.now(), id);
      throw error;
    }
  }

  jobs.register('enrich-issue', enrichIssue);
  // Fill in reports that haven't been looked up yet (new installs, reports from before this
  // feature, or lookups that failed). A few at a time, gently, so we stay a polite API user.
  // On startup, retry every incomplete lookup right away (a fix or new key may have just been deployed).
  function backfill(startup = false) {
    const retryBefore = startup ? Date.now() : Date.now() - 6 * 60 * 60 * 1000;
    const incomeMissing = censusKey() ? `OR (tract_geoid NOT IN (SELECT geoid FROM tract_income) OR substr(tract_geoid, 1, 2) NOT IN (SELECT state FROM state_income))` : '';
    const rows = db.prepare(`SELECT id FROM issues WHERE hidden_at IS NULL AND (enrich_failed_at IS NULL OR enrich_failed_at < ?)
      AND (enriched_at IS NULL OR (enriched_at < ? AND tract_geoid IS NOT NULL AND (nearby_fatal_crashes IS NULL ${incomeMissing})))
      LIMIT ${startup ? 40 : 8}`).all(retryBefore, retryBefore);
    rows.forEach((row, i) => jobs.schedule('enrich-issue', { id: row.id }, Date.now() + i * 3000));
  }
  jobs.every('enrich-backfill', 15 * 60 * 1000, () => backfill());
  setTimeout(() => { try { backfill(true); } catch (error) { console.error('Impact backfill failed:', error.message); } }, Number(process.env.IMPACT_FIRST_RUN_MS) || 20_000).unref();

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  function summarize(rows) {
    const fixed = rows.filter((r) => r.fixedAt);
    const days = fixed.map((r) => (r.fixedAt - r.created_at) / DAY);
    return {
      reports: rows.length,
      fixed: fixed.length,
      open: rows.length - fixed.length,
      fixRate: rows.length ? fixed.length / rows.length : null,
      medianDaysToFix: days.length ? Math.round(median(days) * 10) / 10 : null,
    };
  }

  function impactSnapshot() {
    const rows = db.prepare(`SELECT i.id, i.title, i.distance, i.status, i.created_at, i.status_updated_at, i.lat, i.lng,
        i.tract_geoid, i.nearby_fatal_crashes, i.nearby_fatalities, i.enriched_at, ti.median_income AS tract_income, si.median_income AS state_income,
        (SELECT MIN(created_at) FROM issue_events e WHERE e.issue_id = i.id AND e.status = 'resolved') AS resolved_event
      FROM issues i
      LEFT JOIN tract_income ti ON ti.geoid = i.tract_geoid
      LEFT JOIN state_income si ON si.state = substr(i.tract_geoid, 1, 2)
      WHERE i.hidden_at IS NULL`).all()
      .map((r) => ({ ...r, fixedAt: r.status === 'resolved' ? (r.resolved_event || r.status_updated_at || r.created_at) : null }));

    const byAreaMap = new Map();
    rows.forEach((r) => { if (!byAreaMap.has(r.distance)) byAreaMap.set(r.distance, []); byAreaMap.get(r.distance).push(r); });
    const byArea = [...byAreaMap].map(([area, list]) => ({ area, ...summarize(list) }))
      .sort((a, b) => b.reports - a.reports).slice(0, 12);

    const oldestOpen = rows.filter((r) => !r.fixedAt).sort((a, b) => a.created_at - b.created_at).slice(0, 5)
      .map((r) => ({ id: r.id, title: r.title, area: r.distance, status: r.status, daysOpen: Math.floor((Date.now() - r.created_at) / DAY) }));

    // Equity: compare each report's tract income with its state's median.
    const bands = [
      { key: 'lower', label: 'Lower-income areas', note: 'tract median income under 80% of the state median' },
      { key: 'middle', label: 'Middle-income areas', note: '80% to 120% of the state median' },
      { key: 'higher', label: 'Higher-income areas', note: 'over 120% of the state median' },
    ];
    const bandOf = (r) => {
      if (!r.tract_income || !r.state_income) return null;
      const ratio = r.tract_income / r.state_income;
      return ratio < 0.8 ? 'lower' : ratio <= 1.2 ? 'middle' : 'higher';
    };
    const withBand = rows.map((r) => ({ ...r, band: bandOf(r) }));
    const equity = bands.map((b) => ({ ...b, ...summarize(withBand.filter((r) => r.band === b.key)) }));

    const lookedUp = rows.filter((r) => r.enriched_at);
    const nearCrash = rows.filter((r) => r.nearby_fatal_crashes > 0);
    return {
      overall: summarize(rows),
      byArea,
      oldestOpen,
      equity: { bands: equity, covered: withBand.filter((r) => r.band).length, total: rows.length, acsYear: ACS_YEAR, incomeDataOn: Boolean(censusKey()) },
      safety: {
        lookedUp: lookedUp.length,
        reportsNearFatalCrashes: nearCrash.length,
        fatalitiesNearReports: nearCrash.reduce((n, r) => n + (r.nearby_fatalities || 0), 0),
        radiusMeters: NEAR_METERS,
        fromYear: FARS_TO_YEAR - FARS_YEARS + 1,
        toYear: FARS_TO_YEAR,
        hotspots: nearCrash.sort((a, b) => b.nearby_fatal_crashes - a.nearby_fatal_crashes).slice(0, 5)
          .map((r) => ({ id: r.id, title: r.title, area: r.distance, crashes: r.nearby_fatal_crashes, fatalities: r.nearby_fatalities })),
      },
      updatedAt: Date.now(),
    };
  }

  // Rebuild when anything changes (a new report, status, lookup, or hide), at most once a minute otherwise.
  let cache = null;
  let cacheKey = '';
  router.get('/impact', (req, res) => {
    const key = JSON.stringify(db.prepare(`SELECT (SELECT MAX(id) FROM issue_events) AS e, (SELECT COUNT(*) FROM issues WHERE hidden_at IS NULL) AS n,
      (SELECT MAX(enriched_at) FROM issues) AS x`).get());
    if (!cache || key !== cacheKey || Date.now() - cache.updatedAt > 60_000) { cache = impactSnapshot(); cacheKey = key; }
    res.set('Cache-Control', 'no-cache').json(cache);
  });

  router.get('/impact/crashes', (req, res) => {
    const points = [];
    for (const row of db.prepare('SELECT crashes FROM county_crashes').all()) {
      for (const c of JSON.parse(row.crashes)) {
        points.push([Math.round(c.lat * 1e5) / 1e5, Math.round(c.lng * 1e5) / 1e5, c.year, c.fatals]);
        if (points.length >= 5000) break;
      }
    }
    res.set('Cache-Control', 'public, max-age=600').json({ crashes: points, fromYear: FARS_TO_YEAR - FARS_YEARS + 1, toYear: FARS_TO_YEAR, source: 'NHTSA Fatality Analysis Reporting System (FARS)' });
  });

  return {
    queue: (id) => jobs.schedule('enrich-issue', { id }, Date.now() + 2000),
    // Extra fields for a report's detail view.
    safetyFor(row) {
      if (!(row.nearby_fatal_crashes > 0)) return null;
      return { fatalCrashes: row.nearby_fatal_crashes, fatalities: row.nearby_fatalities, radiusMeters: NEAR_METERS, fromYear: FARS_TO_YEAR - FARS_YEARS + 1, toYear: FARS_TO_YEAR };
    },
  };
}

module.exports = { setupImpact, metersBetween };
