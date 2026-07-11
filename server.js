const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PORT = 3000;
const GTFS_ZIP = path.join(__dirname, 'google_transit.zip');
const CACHE = path.join(__dirname, '.gtfs-cache.json');
const DATA_DIR = path.join(__dirname, 'data');
const HIST_FILE = path.join(DATA_DIR, 'hist-speed.json');

const AMTAB_VEH = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition';
const AMTAB_TRIP = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates';

const RUSH_START = 6, RUSH_END = 10, RUSH_START2 = 15, RUSH_END2 = 19;
const FAR_THRESHOLD_M = 250;
const DEFAULT_SPEED = 20;
const RUSH_FACTOR = 0.85;
const ETA_MAX_MIN = 120;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css',
    '.json': 'application/json'
};

let gtfsData = { routes: {}, stops: [], shapes: {}, stopInfo: {}, routeShapes: {}, graphs: {}, stopRoutePos: {}, stopSequence: {} };
let vehiclesCache = [], delaysCache = {}, etasCache = {};
let histSpeed = {}, obsBuffer = [], obsCount = 0, logStream = null, logDate = '';

// ── GTFS Cache ───────────────────────────────────────────────────────────────

function loadCache() {
    if (fs.existsSync(CACHE)) {
        try {
            gtfsData = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
            gtfsData.stopInfo = gtfsData.stopInfo || {};
            gtfsData.routeShapes = gtfsData.routeShapes || {};
            if (!gtfsData.graphs || Object.keys(gtfsData.graphs).length === 0) buildGraphs();
            if (!gtfsData.stopRoutePos || Object.keys(gtfsData.stopRoutePos).length === 0) buildStopRoutePositions();
            if (!gtfsData.stopSequence) buildStopSequences();
            console.log('  GTFS cache loaded: ' + Object.keys(gtfsData.routes).length + ' routes, ' +
                gtfsData.stops.length + ' stops, ' + Object.keys(gtfsData.shapes).length + ' shapes, ' +
                Object.keys(gtfsData.graphs).length + ' graphs\n');
            return true;
        } catch (e) { console.error('Cache load error:', e.message); }
    }
    return false;
}

function extractAll() {
    if (!fs.existsSync(GTFS_ZIP)) { console.log('  google_transit.zip not found'); return; }
    console.log('  Extracting GTFS from google_transit.zip...');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-'));
    try {
        const outDir = path.join(tmpDir, 'ext');
        fs.mkdirSync(outDir);
        execSync(`PowerShell -NoProfile -Command "Expand-Archive -Path '${GTFS_ZIP}' -DestinationPath '${outDir}' -Force"`, { timeout: 30000 });

        function parseCSV(fp, cb) {
            const p = path.join(outDir, fp);
            if (!fs.existsSync(p)) return;
            const text = fs.readFileSync(p, 'utf8');
            const lines = text.split('\n').filter(l => l.trim());
            const hdr = lines[0].split(',').map(h => h.trim().replace(/\r/g, ''));
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.trim().replace(/\r/g, ''));
                const obj = {};
                hdr.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
                cb(obj);
            }
        }

        parseCSV('routes.txt', r => {
            if (r.route_id) {
                if (!r.route_color) r.route_color = '';
                if (!r.route_text_color) r.route_text_color = '';
                gtfsData.routes[r.route_id] = r;
            }
        });

        const tripRoutes = {};
        parseCSV('trips.txt', t => {
            if (t.trip_id && t.route_id) {
                tripRoutes[t.trip_id] = { route_id: t.route_id, headsign: t.trip_headsign || '', direction: t.direction_id || '', shape_id: t.shape_id || '' };
            }
        });

        const stopTimes = {};
        parseCSV('stop_times.txt', st => {
            if (st.trip_id && st.stop_id) {
                const trip = tripRoutes[st.trip_id];
                if (trip) {
                    if (!stopTimes[st.stop_id]) stopTimes[st.stop_id] = [];
                    stopTimes[st.stop_id].push({
                        route_id: trip.route_id,
                        arrival: st.arrival_time || '',
                        headsign: trip.headsign,
                        direction: trip.direction
                    });
                }
            }
        });

        Object.keys(stopTimes).forEach(sid => {
            const times = stopTimes[sid];
            const byRoute = {};
            times.forEach(t => {
                if (!byRoute[t.route_id]) byRoute[t.route_id] = { route_id: t.route_id, arrivals: [], headsign: t.headsign };
                if (t.arrival) byRoute[t.route_id].arrivals.push(t.arrival);
            });
            Object.keys(byRoute).forEach(rid => {
                byRoute[rid].arrivals.sort();
                byRoute[rid].next = byRoute[rid].arrivals.slice(0, 3);
                delete byRoute[rid].arrivals;
            });
            gtfsData.stopInfo[sid] = Object.values(byRoute);
        });

        gtfsData.routeShapes = {};
        Object.keys(tripRoutes).forEach(tid => {
            const t = tripRoutes[tid];
            if (t.shape_id) {
                if (!gtfsData.routeShapes[t.route_id]) gtfsData.routeShapes[t.route_id] = [];
                if (gtfsData.routeShapes[t.route_id].indexOf(t.shape_id) === -1) {
                    gtfsData.routeShapes[t.route_id].push(t.shape_id);
                }
            }
        });

        parseCSV('stops.txt', s => {
            if (s.stop_id && s.stop_lat && s.stop_lon) {
                gtfsData.stops.push({
                    id: s.stop_id,
                    name: s.stop_name || '',
                    lat: parseFloat(s.stop_lat),
                    lon: parseFloat(s.stop_lon),
                    code: s.stop_code || '',
                    zone: s.zone_id || ''
                });
            }
        });

        parseCSV('shapes.txt', s => {
            if (s.shape_id && s.shape_pt_lat && s.shape_pt_lon) {
                const sid = s.shape_id;
                if (!gtfsData.shapes[sid]) gtfsData.shapes[sid] = [];
                gtfsData.shapes[sid].push({
                    lat: parseFloat(s.shape_pt_lat),
                    lon: parseFloat(s.shape_pt_lon),
                    seq: parseInt(s.shape_pt_sequence) || 0
                });
            }
        });

        Object.keys(gtfsData.shapes).forEach(sid => {
            gtfsData.shapes[sid].sort((a, b) => a.seq - b.seq);
        });

        buildGraphs();
        buildStopRoutePositions();
        buildStopSequences();

        console.log('  GTFS extracted: ' + Object.keys(gtfsData.routes).length + ' routes, ' +
            gtfsData.stops.length + ' stops, ' + Object.keys(gtfsData.shapes).length + ' shapes, ' +
            Object.keys(gtfsData.graphs).length + ' graphs\n');
        fs.writeFileSync(CACHE, JSON.stringify(gtfsData));
    } catch (e) {
        console.error('  GTFS error:', e.message);
    }
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
}

// ── Directed Graph ───────────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function closestPointOnSegment(plat, plon, lat1, lon1, lat2, lon2) {
    const dx = lat2 - lat1, dy = lon2 - lon1, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((plat - lat1) * dx + (plon - lon1) * dy) / len2)) : 0;
    return { dist: haversineKm(plat, plon, lat1 + t * dx, lon1 + t * dy), offset: t * haversineKm(lat1, lon1, lat2, lon2) };
}

function buildGraphs() {
    gtfsData.graphs = {};
    Object.keys(gtfsData.shapes).forEach(sid => {
        const pts = gtfsData.shapes[sid];
        const edges = [];
        let cum = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const d = haversineKm(pts[i].lat, pts[i].lon, pts[i + 1].lat, pts[i + 1].lon);
            edges.push({ fl: pts[i].lat, fn: pts[i].lon, tl: pts[i + 1].lat, tn: pts[i + 1].lon, d, cs: cum, ce: cum + d });
            cum += d;
        }
        gtfsData.graphs[sid] = edges;
    });
}

function projectToGraph(lat, lon, edges) {
    let best = { dist: Infinity, cumDist: 0 };
    edges.forEach(e => {
        const p = closestPointOnSegment(lat, lon, e.fl, e.fn, e.tl, e.tn);
        if (p.dist < best.dist) best = { dist: p.dist, cumDist: e.cs + p.offset };
    });
    return best.cumDist;
}

function buildStopRoutePositions() {
    gtfsData.stopRoutePos = {};
    const stopMap = {};
    gtfsData.stops.forEach(s => stopMap[s.id] = s);
    Object.keys(gtfsData.stopInfo).forEach(sid => {
        const s = stopMap[sid];
        if (!s) return;
        gtfsData.stopInfo[sid].forEach(r => {
            const sids = gtfsData.routeShapes[r.route_id];
            if (!sids || !sids.length) return;
            const edges = gtfsData.graphs[sids[0]];
            if (!edges) return;
            if (!gtfsData.stopRoutePos[r.route_id]) gtfsData.stopRoutePos[r.route_id] = {};
            gtfsData.stopRoutePos[r.route_id][sid] = projectToGraph(s.lat, s.lon, edges);
        });
    });
}

function buildStopSequences() {
    gtfsData.stopSequence = {};
    Object.keys(gtfsData.stopRoutePos).forEach(rid => {
        const stops = gtfsData.stopRoutePos[rid];
        gtfsData.stopSequence[rid] = Object.keys(stops).sort((a, b) => stops[a] - stops[b]);
    });
}

// ── Feature Extraction (2024 Paper) ──────────────────────────────────────────

function isRushHour(h) { return (h >= RUSH_START && h < RUSH_END) || (h >= RUSH_START2 && h < RUSH_END2); }
function isWeekend(d) { return d === 0 || d === 6; }
function timeBlock(h) { return Math.floor(h / 2) * 2; }

function extractFeatures(v, vehCum, nextStopId) {
    const now = new Date();
    const h = now.getHours(), dow = now.getDay();
    const stops = gtfsData.stopRoutePos[v.rid];
    if (!stops || !nextStopId) return null;

    const distToStop = stops[nextStopId] - vehCum;
    if (distToStop <= 0) return null;

    const dayType = isWeekend(dow) ? 'weekend' : 'workday';
    const rush = isRushHour(h);
    const far = distToStop * 1000 > FAR_THRESHOLD_M; // convert km to m

    return {
        ts: now.toISOString(),
        vid: v.id, rid: v.rid, tid: v.tid,
        lat: v.lat, lon: v.lon,
        spd_mps: v.spd,
        cum_km: vehCum,
        dist_m: Math.round(distToStop * 1000),
        delay_s: delaysCache[v.tid] || 0,
        day: dayType,
        rush,
        far,
        next_stop: nextStopId
    };
}

// ── Data Logging ─────────────────────────────────────────────────────────────

function ensureLogStream() {
    const today = new Date().toISOString().substring(0, 10);
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (today !== logDate) {
        if (logStream) { try { logStream.end(); } catch (e) {} }
        const logPath = path.join(DATA_DIR, 'observations-' + today + '.jsonl');
        logStream = fs.createWriteStream(logPath, { flags: 'a' });
        logDate = today;
    }
}

function flushLogs() {
    if (!obsBuffer.length) return;
    ensureLogStream();
    obsBuffer.forEach(o => logStream.write(JSON.stringify(o) + '\n'));
    obsBuffer = [];
}

function logObservation(feat) {
    if (!feat) return;
    obsBuffer.push(feat);
    obsCount++;
    if (obsBuffer.length >= 100) flushLogs();
}

// ── Historical Speed (vai) ──────────────────────────────────────────────────

function loadHistSpeed() {
    try {
        if (fs.existsSync(HIST_FILE)) histSpeed = JSON.parse(fs.readFileSync(HIST_FILE, 'utf8'));
    } catch (e) {}
    histSpeed = histSpeed || {};
}

function saveHistSpeed() {
    try {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(HIST_FILE, JSON.stringify(histSpeed));
    } catch (e) {}
}

function getVai(rid, block) {
    const key = rid + '_' + block;
    const h = histSpeed[key];
    return h ? h.avg : DEFAULT_SPEED;
}

function updateVai(rid, block, speedKmph) {
    const key = rid + '_' + block;
    if (!histSpeed[key]) histSpeed[key] = { sum: 0, count: 0, avg: DEFAULT_SPEED };
    const h = histSpeed[key];
    h.sum += speedKmph;
    h.count++;
    h.avg = h.sum / h.count;
    if (h.count % 50 === 0) saveHistSpeed();
}

// ── Real-time Polling + ETA ─────────────────────────────────────────────────

function fetchJSON(url, cb) {
    https.get(url, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => { try { cb(null, JSON.parse(b)); } catch (e) { cb(e); } });
    }).on('error', cb);
}

function pollRealtime() {
    let pending = 2;
    function done() { if (--pending === 0) { computeETAs(); flushLogs(); } }

    fetchJSON(AMTAB_VEH, (err, vehData) => {
        if (!err && vehData) {
            const vehicles = [];
            (vehData.Entity || vehData.Entities || []).forEach(e => {
                const veh = e.Vehicle;
                if (!veh || !veh.Position) return;
                vehicles.push({
                    id: e.Id, rid: (veh.Trip && veh.Trip.RouteId) || '',
                    tid: (veh.Trip && veh.Trip.TripId) || '',
                    lat: veh.Position.Latitude, lon: veh.Position.Longitude,
                    spd: veh.Position.Speed || 0
                });
            });
            vehiclesCache = vehicles;
        }
        done();
    });

    fetchJSON(AMTAB_TRIP, (err, tripData) => {
        if (!err && tripData) {
            const d = {};
            (tripData.Entity || tripData.Entities || []).forEach(e => {
                const tu = e.TripUpdate;
                if (tu && tu.Trip && tu.Trip.TripId) {
                    const a = (tu.StopTimeUpdate || []).map(s => s.Arrival && s.Arrival.Delay ? s.Arrival.Delay : null).filter(Boolean);
                    d[tu.Trip.TripId] = a.length ? Math.max.apply(null, a) : 0;
                }
            });
            delaysCache = d;
        }
        done();
    });
}

function computeETAs() {
    const etas = {};
    const now = new Date();
    const h = now.getHours(), block = timeBlock(h);

    vehiclesCache.forEach(v => {
        const sids = gtfsData.routeShapes[v.rid];
        if (!sids || !sids.length) return;
        const edges = gtfsData.graphs[sids[0]];
        if (!edges) return;
        const vehCum = projectToGraph(v.lat, v.lon, edges);
        const stops = gtfsData.stopRoutePos[v.rid];
        if (!stops) return;

        // Find next stop and log feature
        const seq = gtfsData.stopSequence[v.rid] || [];
        let nextStopId = null;
        for (let i = 0; i < seq.length; i++) {
            if (vehCum < stops[seq[i]]) { nextStopId = seq[i]; break; }
        }

        const feat = extractFeatures({ ...v }, vehCum, nextStopId);
        if (feat) logObservation(feat);

        // Compute ETA with weighted speed (2007 paper) + rush/far adjustments
        Object.keys(stops).forEach(sid => {
            if (vehCum >= stops[sid]) return;
            const remaining = stops[sid] - vehCum;
            const vr = v.spd * 3.6;
            const vai = getVai(v.rid, block);
            // Weighted speed: closer to stop → more weight on current speed
            const totalLen = stops[sid]; // total route length to this stop
            const a = totalLen - vehCum; // dist to stop (Sif)
            const b = vehCum;             // dist from start (Sib approximation)
            const vi = (a * vr + b * vai) / (a + b) || vai;
            // Apply rush hour factor
            const rushFactor = feat && feat.rush ? RUSH_FACTOR : 1;
            // Apply far status: if close to stop, reduce speed (bus slowing down)
            const farFactor = feat && !feat.far ? 0.7 : 1;
            const finalSpeed = Math.max(vi * rushFactor * farFactor, 3);
            const eta = Math.round(remaining / finalSpeed * 60);
            if (eta > ETA_MAX_MIN) return;
            if (!etas[sid]) etas[sid] = {};
            if (!etas[sid][v.rid] || eta < etas[sid][v.rid].eta) {
                etas[sid][v.rid] = { eta, delay: delaysCache[v.tid] || 0, vid: v.id };
            }
        });

        // Update historical speed for the route
        if (v.spd > 0) updateVai(v.rid, block, v.spd * 3.6);
    });
    etasCache = etas;
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initRealtime() {
    loadHistSpeed();
    pollRealtime();
    setInterval(pollRealtime, 10000);
    // Flush logs every 60s
    setInterval(flushLogs, 60000);
    // Save hist speed every 5 min
    setInterval(saveHistSpeed, 300000);
}

// ── Server ───────────────────────────────────────────────────────────────────

http.createServer((req, res) => {
    const jHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };
    const url = req.url;

    if (url === '/api/vehicles') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(vehiclesCache));
    }
    if (url === '/api/trip-updates') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(delaysCache));
    }
    if (url === '/api/etas') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(etasCache));
    }
    if (url === '/api/routes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.routes));
    }
    if (url === '/api/stops') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.stops));
    }
    if (url === '/api/shapes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.shapes));
    }
    if (url === '/api/stop-info') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.stopInfo));
    }
    if (url === '/api/route-shapes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.routeShapes));
    }
    if (url === '/api/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            vehicles: vehiclesCache.length,
            etasStops: Object.keys(etasCache).length,
            obsToday: obsCount,
            histRoutes: Object.keys(histSpeed).length,
            logDate
        }));
    }

    const file = path.join(__dirname, url === '/' ? 'index.html' : url);
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(file);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
    });
}).listen(PORT, () => {
    console.log('\n  🚌  Bari AMTAB Bus Map');
    console.log('  Open: http://localhost:' + PORT + '\n');
    if (!loadCache()) extractAll();
    initRealtime();
});
