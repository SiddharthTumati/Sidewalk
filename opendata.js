// Open data: every public report as a spreadsheet (CSV) or map data (GeoJSON), free for anyone
// to download and reuse. Only the public parts of a report are included: never names, emails,
// accounts, networks, or photos themselves (just how many there are).

const STATUS_LABELS = {
  submitted: 'Submitted', ai_reviewed: 'Reviewed for clarity', community_priority: 'Neighborhood priority',
  sent_to_agency: 'Sent to the city', in_progress: 'In progress', resolved: 'Fixed',
};
const FIELDS = ['id', 'title', 'description', 'category', 'status', 'area', 'latitude', 'longitude', 'reported_at', 'status_updated_at', 'fixed_at', 'days_to_fix', 'backers', 'photos', 'url'];

// Spreadsheet apps run cells that start with = + - @ as formulas; prefix those so they stay text.
const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function setupOpenData({ db, router, limit, serializeIssue, appUrl }) {
  let cache = null;

  function rows() {
    const key = JSON.stringify(db.prepare('SELECT (SELECT MAX(id) FROM issue_events) AS e, (SELECT COUNT(*) FROM issues WHERE hidden_at IS NULL) AS n, (SELECT COUNT(*) FROM supports) AS s').get());
    if (cache && cache.key === key && Date.now() - cache.at < 5 * 60 * 1000) return cache.rows;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
    const list = db.prepare('SELECT * FROM issues WHERE hidden_at IS NULL ORDER BY created_at DESC LIMIT 5000').all().map((row) => {
      const issue = serializeIssue(row);
      const fixedEvent = row.status === 'resolved'
        ? db.prepare("SELECT MIN(created_at) AS at FROM issue_events WHERE issue_id = ? AND status = 'resolved'").get(row.id).at || row.status_updated_at
        : null;
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        category: row.category_label,
        status: STATUS_LABELS[row.status] || 'Submitted',
        area: row.distance,
        latitude: Math.round(row.lat * 1e5) / 1e5,
        longitude: Math.round(row.lng * 1e5) / 1e5,
        reported_at: iso(row.created_at),
        status_updated_at: iso(row.status_updated_at || row.created_at),
        fixed_at: iso(fixedEvent),
        days_to_fix: fixedEvent ? Math.round(((fixedEvent - row.created_at) / 86_400_000) * 10) / 10 : null,
        backers: issue.supporters,
        photos: issue.photos.length,
        url: `${appUrl()}/r/${encodeURIComponent(row.id)}`,
      };
    });
    cache = { key, at: Date.now(), rows: list };
    return list;
  }

  const openLimit = limit({ name: 'open-data', max: 60, windowMs: 60 * 60 * 1000, message: 'Too many downloads from your network. Please try again in an hour.' });
  const openHeaders = (res) => res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' });

  router.get('/open/reports.csv', openLimit, (req, res) => {
    const list = rows();
    const csv = [FIELDS.join(','), ...list.map((r) => FIELDS.map((f) => csvCell(r[f])).join(','))].join('\r\n');
    openHeaders(res).type('text/csv; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="sidewalk-reports-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(`﻿${csv}\r\n`);
  });

  router.get('/open/reports.geojson', openLimit, (req, res) => {
    const list = rows();
    openHeaders(res).type('application/geo+json').json({
      type: 'FeatureCollection',
      metadata: { source: 'Sidewalk community reports', generated: new Date().toISOString(), count: list.length, license: 'Free to reuse with credit to Sidewalk. Reports are written by residents and are not official government records.' },
      features: list.map(({ latitude, longitude, ...props }) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties: props })),
    });
  });

  router.get('/open/summary', openLimit, (req, res) => {
    const list = rows();
    const fixed = list.filter((r) => r.fixed_at);
    openHeaders(res).json({ reports: list.length, fixed: fixed.length, newest: list[0]?.reported_at || null, fields: FIELDS });
  });
}

module.exports = { setupOpenData, csvCell };
