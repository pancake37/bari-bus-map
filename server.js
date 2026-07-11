const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PORT = 3000;
const GTFS_ZIP = path.join(__dirname, 'google_transit.zip');
const CACHE = path.join(__dirname, '.gtfs-cache.json');

const AMTAB_VEH = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition';
const AMTAB_TRIP = 'https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css',
    '.json': 'application/json'
};

let gtfsData = { routes: {}, stops: [], shapes: {}, stopInfo: {}, routeShapes: {}, graphs: {}, stopRoutePos: {} };
let vehiclesCache = [], delaysCache = {}, etasCache = {};

// ── GTFS Cache ───────────────────────────────────────────────────────────────

function loadCache() {
    if (fs.existsSync(CACHE)) {
        try {
            gtfsData = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
            gtfsData.stopInfo = gtfsData.stopInfo || {};
            gtfsData.routeShapes = gtfsData.routeShapes || {};
            if (!gtfsData.graphs || Object.keys(gtfsData.graphs).length === 0) buildGraphs();
            if (!gtfsData.stopRoutePos || Object.keys(gtfsData.stopRoutePos).length === 0) buildStopRoutePositions();
            console.log('  GTFS cache loaded: ' + Object.keys(gtfsData.routes).length + ' routes, ' +
                gtfsData.stops.length + ' stops, ' + Object.keys(gtfsData.shapes).length + ' shapes, ' +
                Object.keys(gtfsData.graphs).length + ' graphs\n');
            return true;
        } catch (e) {}
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

        function parseCSV(filePath, callback) {
            const p = path.join(outDir, filePath);
            if (!fs.existsSync(p)) return;
            const text = fs.readFileSync(p, 'utf8');
            const lines = text.split('\n').filter(l => l.trim());
            const hdr = lines[0].split(',').map(h => h.trim().replace(/\r/g, ''));
            for (let i = 1; i < lines.length; i++) {
                const vals = lines[i].split(',').map(v => v.trim().replace(/\r/g, ''));
                const obj = {};
                hdr.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
                callback(obj);
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

        // Build directed graphs and stop positions
        buildGraphs();
        buildStopRoutePositions();

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
    const dx = lat2 - lat1, dy = lon2 - lon1;
    const t = Math.max(0, Math.min(1, ((plat - lat1) * dx + (plon - lon1) * dy) / (dx * dx + dy * dy)));
    const cplat = lat1 + t * dx, cplon = lon1 + t * dy;
    return { dist: haversineKm(plat, plon, cplat, cplon), offset: t * haversineKm(lat1, lon1, lat2, lon2) };
}

function buildGraphs() {
    gtfsData.graphs = {};
    Object.keys(gtfsData.shapes).forEach(sid => {
        const pts = gtfsData.shapes[sid];
        const edges = [];
        let cum = 0;
        for (let i = 0; i < pts.length - 1; i++) {
            const d = haversineKm(pts[i].lat, pts[i].lon, pts[i+1].lat, pts[i+1].lon);
            edges.push({ fl: pts[i].lat, fn: pts[i].lon, tl: pts[i+1].lat, tn: pts[i+1].lon, d: d, cs: cum, ce: cum + d });
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

// ── Real-time Polling + ETA ─────────────────────────────────────────────────

function fetchJSON(url, cb) {
    https.get(url, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => { try { cb(null, JSON.parse(b)); } catch(e) { cb(e); } });
    }).on('error', cb);
}

function pollRealtime() {
    let pending = 2;
    function done() { if (--pending === 0) computeETAs(); }

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
    vehiclesCache.forEach(v => {
        const sids = gtfsData.routeShapes[v.rid];
        if (!sids || !sids.length) return;
        const edges = gtfsData.graphs[sids[0]];
        if (!edges) return;
        const vehCum = projectToGraph(v.lat, v.lon, edges);
        const stops = gtfsData.stopRoutePos[v.rid];
        if (!stops) return;
        Object.keys(stops).forEach(sid => {
            if (vehCum >= stops[sid]) return;
            const remaining = stops[sid] - vehCum;
            const speed = v.spd * 3.6 || 20;
            const eta = Math.round(remaining / speed * 60);
            if (eta > 120) return;
            if (!etas[sid]) etas[sid] = {};
            if (!etas[sid][v.rid] || eta < etas[sid][v.rid].eta) {
                etas[sid][v.rid] = { eta, delay: delaysCache[v.tid] || 0, vid: v.id };
            }
        });
    });
    etasCache = etas;
}

function initRealtime() {
    pollRealtime();
    setInterval(pollRealtime, 10000);
}

// ── Server ───────────────────────────────────────────────────────────────────

http.createServer((req, res) => {
    const jHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };

    if (req.url === '/api/vehicles') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(vehiclesCache));
    }
    if (req.url === '/api/trip-updates') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(delaysCache));
    }
    if (req.url === '/api/etas') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(etasCache));
    }
    if (req.url === '/api/routes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.routes));
    }
    if (req.url === '/api/stops') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.stops));
    }
    if (req.url === '/api/shapes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.shapes));
    }
    if (req.url === '/api/stop-info') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.stopInfo));
    }
    if (req.url === '/api/route-shapes') {
        res.writeHead(200, jHead);
        return res.end(JSON.stringify(gtfsData.routeShapes));
    }

    const file = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
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
