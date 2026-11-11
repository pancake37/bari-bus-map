'use strict';
const fs = require('fs'),
  path = require('path'),
  os = require('os'),
  zlib = require('zlib'),
  crypto = require('crypto');
const { extractZip } = require('../lib/zip'),
  { parseCSVLine } = require('../lib/csv');

const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bari-mob-'));
const files = extractZip(path.join(root, 'google_transit.zip'), tmp).files || [];

function csv(name) {
  const fp = path.join(tmp, name);
  if (!fs.existsSync(fp)) return [];
  const lines = fs
    .readFileSync(fp, 'utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter(Boolean),
    h = parseCSVLine(lines.shift());
  return lines.map((l) =>
    Object.fromEntries(parseCSVLine(l).map((v, i) => [h[i], v]))
  );
}

const cal = csv('calendar.txt'),
  dates = csv('calendar_dates.txt'),
  trips = csv('trips.txt'),
  stops = csv('stops.txt'),
  times = csv('stop_times.txt'),
  shapes = csv('shapes.txt'),
  routes = csv('routes.txt');

const now = new Date(),
  today = Number(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .replaceAll('-', '')
  );

const active = new Set();
for (const d of dates) {
  if (+d.date === today) {
    if (d.exception_type === '1') active.add(d.service_id);
    else active.delete(d.service_id);
  }
}

const dow = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Rome',
  weekday: 'short',
})
  .format(now)
  .toLowerCase();
const col = {
  sun: 'sunday',
  mon: 'monday',
  tue: 'tuesday',
  wed: 'wednesday',
  thu: 'thursday',
  fri: 'friday',
  sat: 'saturday',
}[dow];
for (const c of cal) {
  if (+c.start_date <= today && today <= +c.end_date && c[col] === '1') {
    active.add(c.service_id);
  }
}

const date = String(today),
  tripMap = new Map(
    trips.filter((t) => active.has(t.service_id)).map((t) => [t.trip_id, t])
  );

const stopMap = new Map(
  stops.map((s) => [
    s.stop_id,
    { id: s.stop_id, name: s.stop_name, point: [+s.stop_lon, +s.stop_lat] },
  ])
);

const geo = new Map();
for (const p of shapes) {
  if (!geo.has(p.shape_id)) geo.set(p.shape_id, []);
  geo.get(p.shape_id).push([+p.shape_pt_lon, +p.shape_pt_lat, +p.shape_pt_sequence]);
}
for (const a of geo.values()) a.sort((x, y) => x[2] - y[2]);

const rad = Math.PI / 180,
  dist = (a, b) => {
    const x =
        (b[0] - a[0]) * 111320 * Math.cos(((a[1] + b[1]) / 2) * rad),
      y = (b[1] - a[1]) * 111320;
    return Math.hypot(x, y);
  };

const groups = new Map(),
  stopSet = new Set(),
  excluded = { nonpositive: 0, nonprogress: 0, missing_stop: 0 };
const byTrip = new Map();
for (const t of times) {
  if (tripMap.has(t.trip_id)) {
    if (!byTrip.has(t.trip_id)) byTrip.set(t.trip_id, []);
    byTrip.get(t.trip_id).push(t);
  }
}

function sec(s) {
  const m = /^(\d+):(\d\d):(\d\d)$/.exec(s || '');
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : NaN;
}
function median(a) {
  a.sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)];
}

for (const [tid, list] of byTrip) {
  list.sort((a, b) => +a.stop_sequence - +b.stop_sequence);
  const t = tripMap.get(tid);
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i],
      b = list[i + 1],
      s1 = stopMap.get(a.stop_id),
      s2 = stopMap.get(b.stop_id);
    if (!s1 || !s2) {
      excluded.missing_stop++;
      continue;
    }
    const departure = sec(a.departure_time),
      arrival = sec(b.arrival_time),
      duration = arrival - departure;
    if (!(duration > 0)) {
      excluded.nonpositive++;
      continue;
    }
    const shape = geo.get(t.shape_id) || [],
      coords = [s1.point, s2.point];
    let metres = dist(...coords);
    if (shape.length > 1) {
      let nearest = (p) =>
          shape.reduce(
            (best, x) => (dist(p, x) < dist(p, best) ? x : best),
            shape[0]
          ),
        p1 = nearest(s1.point),
        p2 = nearest(s2.point),
        i1 = shape.indexOf(p1),
        i2 = shape.indexOf(p2);
      if (i1 <= i2) {
        coords.splice(0, 2, ...shape.slice(i1, i2 + 1).map((x) => x.slice(0, 2)));
        metres = 0;
        for (let j = 1; j < coords.length; j++) metres += dist(coords[j - 1], coords[j]);
      }
    }
    if (!(metres > 0)) {
      excluded.nonprogress++;
      continue;
    }
    const route = t.route_id || '',
      key = [route, t.direction_id || '', a.stop_id, b.stop_id].join('|');
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        route,
        routeName: route,
        direction: t.direction_id || '',
        fromId: a.stop_id,
        toId: b.stop_id,
        from: s1.name,
        to: s2.name,
        metres,
        coordinates: coords,
        bands: { all: [], morning: [], day: [], evening: [] },
      });
    const g = groups.get(key),
      hour = departure / 3600;
    g.bands.all.push([duration, departure]);
    if (hour >= 7 && hour < 10) g.bands.morning.push([duration, departure]);
    if (hour >= 10 && hour < 16) g.bands.day.push([duration, departure]);
    if (hour >= 16 && hour < 20) g.bands.evening.push([duration, departure]);
    stopSet.add(a.stop_id);
    stopSet.add(b.stop_id);
  }
}

const segments = [];
for (const g of groups.values()) {
  const bands = {};
  for (const [name, samples] of Object.entries(g.bands)) {
    if (!samples.length) continue;
    const seconds = median(samples.map((x) => x[0]));
    bands[name] = {
      samples: samples.length,
      seconds,
      kmh: +(g.metres / seconds * 3.6).toFixed(2),
    };
  }
  segments.push({ ...g, bands, estimated: 0 });
}

// Load base upstream data
const base = JSON.parse(
  zlib.gunzipSync(fs.readFileSync(path.join(root, '_ref/bari-upstream.json.gz')))
);
base.serviceDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`;
base.segments = segments;
base.stops = [...stopSet].map((id) => {
  const s = stopMap.get(id);
  return { ...s, point: s.point };
});
base.status = segments.length ? 'ready' : 'no-service';
base.exclusions = excluded;
base.coverage = {
  routesInFeed: new Set(trips.map((t) => t.route_id)).size,
  activeRoutes: new Set(segments.map((s) => s.route)).size,
  activeScheduledTrips: tripMap.size,
  activeServices: active.size,
};

// --- Expand Map Extent & Enrich Basemap with Adriatic Sea, Districts and GTFS Road Arteries ---

// 1. Set full bounds for the entire Bari metropolitan transit network
base.mapBounds = [16.71, 41.01, 17.04, 41.18];
base.studyBounds = [16.71, 41.01, 17.04, 41.18];
base.focus = [16.869, 41.115];

// 2. Load ISTAT boundaries if available to generate Adriatic Sea coastline polygon
const istatPath = path.join(root, 'data/bari-istat-p72.json');
if (fs.existsSync(istatPath)) {
  const istatData = JSON.parse(fs.readFileSync(istatPath, 'utf8'));
  const bariFeat = (istatData.features || []).find((f) => f.properties && f.properties.name === 'Bari');
  if (bariFeat && bariFeat.geometry && bariFeat.geometry.coordinates) {
    const ring = bariFeat.geometry.coordinates[0];
    // Find northernmost and easternmost index for coastline
    let northIdx = 0, eastIdx = 0;
    ring.forEach(([lon, lat], i) => {
      if (lat > ring[northIdx][1]) northIdx = i;
      if (lon > ring[eastIdx][0]) eastIdx = i;
    });
    const i1 = Math.min(northIdx, eastIdx);
    const i2 = Math.max(northIdx, eastIdx);
    const coastSlice = ring.slice(i1, i2 + 1);
    // Build polygon covering Adriatic Sea to the north-east
    const seaCoords = [
      ...coastSlice,
      [17.15, coastSlice[coastSlice.length - 1][1]],
      [17.15, 41.25],
      [16.65, 41.25],
      [16.65, coastSlice[0][1]],
      coastSlice[0],
    ];
    base.basemap.features.unshift({
      id: 99990001,
      kind: 'water',
      class: '',
      name: 'Mare Adriatico',
      closed: true,
      coordinates: seaCoords.map(([lon, lat]) => [+lon.toFixed(6), +lat.toFixed(6)]),
    });
  }
}

// 3. Add district labels for all areas of the city (using CAP centroids and key quarters)
const districtLabels = [
  { name: 'Santo Spirito', class: 'suburb', point: [16.7468, 41.1610] },
  { name: 'Palese', class: 'suburb', point: [16.7703, 41.1466] },
  { name: 'Aeroporto di Bari', class: 'quarter', point: [16.7645, 41.1378] },
  { name: 'San Paolo', class: 'suburb', point: [16.8050, 41.1235] },
  { name: 'Stanic', class: 'suburb', point: [16.8385, 41.1169] },
  { name: 'Fiera del Levante', class: 'quarter', point: [16.8415, 41.1360] },
  { name: 'Marconi', class: 'quarter', point: [16.8478, 41.1210] },
  { name: 'Bari Vecchia', class: 'quarter', point: [16.8690, 41.1285] },
  { name: 'Murat', class: 'quarter', point: [16.8698, 41.1200] },
  { name: 'Madonnella', class: 'quarter', point: [16.8830, 41.1190] },
  { name: 'Picone', class: 'quarter', point: [16.8539, 41.1020] },
  { name: 'Poggiofranco', class: 'suburb', point: [16.8520, 41.0920] },
  { name: 'Carrassi', class: 'quarter', point: [16.8710, 41.1010] },
  { name: 'San Pasquale', class: 'quarter', point: [16.8800, 41.1000] },
  { name: 'Japigia', class: 'suburb', point: [16.9022, 41.1086] },
  { name: 'San Giorgio', class: 'quarter', point: [16.9450, 41.0980] },
  { name: 'Torre a Mare', class: 'town', point: [17.0050, 41.0850] },
  { name: 'Carbonara', class: 'town', point: [16.8680, 41.0770] },
  { name: 'Ceglie del Campo', class: 'town', point: [16.8720, 41.0620] },
  { name: 'Loseto', class: 'town', point: [16.8550, 41.0480] },
  { name: 'Modugno', class: 'town', point: [16.7805, 41.0825] },
];

base.basemap.labels = districtLabels;

// 4. Douglas-Peucker line simplification for bus route shapes
function distSq(p1, p2) {
  const dx = (p2[0] - p1[0]) * 111320 * Math.cos(((p1[1] + p2[1]) / 2) * rad);
  const dy = (p2[1] - p1[1]) * 110540;
  return dx * dx + dy * dy;
}
function distToSegmentSq(p, v, w) {
  const l2 = distSq(v, w);
  if (l2 === 0) return distSq(p, v);
  const vx = (w[0] - v[0]) * 111320 * Math.cos(((v[1] + w[1]) / 2) * rad);
  const vy = (w[1] - v[1]) * 110540;
  const px = (p[0] - v[0]) * 111320 * Math.cos(((v[1] + p[1]) / 2) * rad);
  const py = (p[1] - v[1]) * 110540;
  const t = Math.max(0, Math.min(1, (px * vx + py * vy) / l2));
  const proj = [v[0] + (w[0] - v[0]) * t, v[1] + (w[1] - v[1]) * t];
  return distSq(p, proj);
}
function simplifyDP(pts, tolMetres) {
  if (pts.length <= 2) return pts;
  const tolSq = tolMetres * tolMetres;
  function dp(start, end) {
    let maxDist = 0,
      idx = start;
    for (let i = start + 1; i < end; i++) {
      const d = distToSegmentSq(pts[i], pts[start], pts[end]);
      if (d > maxDist) {
        maxDist = d;
        idx = i;
      }
    }
    if (maxDist > tolSq) {
      return [...dp(start, idx).slice(0, -1), ...dp(idx, end)];
    } else {
      return [pts[start], pts[end]];
    }
  }
  return dp(0, pts.length - 1);
}

// 5. Convert all GTFS route shapes to basemap road features
const routeMap = new Map(routes.map((r) => [r.route_id, r.route_short_name || r.route_id]));
const tripShapes = new Map();
for (const t of trips) {
  if (t.shape_id && !tripShapes.has(t.shape_id)) {
    tripShapes.set(t.shape_id, {
      route: routeMap.get(t.route_id) || t.route_id,
      headsign: t.trip_headsign || '',
    });
  }
}

let nextFeatureId = 98000000;
for (const [sid, pts] of geo.entries()) {
  const info = tripShapes.get(sid) || { route: '', headsign: '' };
  // Only include shapes with at least 2 points
  if (pts.length < 2) continue;
  // Apply 8-metre Douglas-Peucker simplification to keep geometry smooth yet fast
  const simplified = simplifyDP(pts, 8).map((p) => [+p[0].toFixed(6), +p[1].toFixed(6)]);
  base.basemap.features.push({
    id: ++nextFeatureId,
    kind: 'road',
    class: 'primary',
    name: 'Linea ' + info.route + (info.headsign ? ' → ' + info.headsign : ''),
    closed: false,
    coordinates: simplified,
  });
}

// Write the enriched city asset
const bytes = zlib.gzipSync(Buffer.from(JSON.stringify(base)));
const sha = crypto.createHash('sha256').update(bytes).digest('hex');
const asset = `cities/bari-${sha}.json.gz`;
fs.writeFileSync(path.join(root, 'mobilita', asset), bytes);

const manifest = {
  schemaVersion: 3,
  metric: 'scheduled-segment-travel-time',
  method:
    'median of scheduled adjacent-stop arrival minus departure; distance along GTFS shape; no dwell; no realtime',
  cities: [
    {
      id: 'bari',
      name: 'Bari',
      areaId: null,
      mode: 'bus',
      status: base.status,
      serviceDate: base.serviceDate,
      asset: { path: asset, sha256: sha, bytes: bytes.length },
    },
  ],
};

let html = fs.readFileSync(path.join(root, 'mobilita/index.html'), 'utf8');
html = html.replace(
  /(<script id="data" type="application\/json">)[\s\S]*?(<\/script>)/,
  `$1\n${JSON.stringify(manifest)}\n$2`
);
fs.writeFileSync(path.join(root, 'mobilita/index.html'), html);

console.log(
  JSON.stringify(
    {
      serviceDate: base.serviceDate,
      segments: segments.length,
      stops: base.stops.length,
      features: base.basemap.features.length,
      labels: base.basemap.labels.length,
      sha,
      bytes: bytes.length,
      files: files.length,
    },
    null,
    2
  )
);
