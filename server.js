const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

const PORT = 3000;
const GTFS_ZIP = path.join(__dirname, 'google_transit.zip');
const CACHE = path.join(__dirname, '.gtfs-cache.json');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css',
    '.json': 'application/json'
};

let gtfsData = { routes: {}, stops: [], shapes: {}, stopInfo: {}, routeShapes: {} };

function loadCache() {
    if (fs.existsSync(CACHE)) {
        try {
            gtfsData = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
            gtfsData.stopInfo = gtfsData.stopInfo || {};
            gtfsData.routeShapes = gtfsData.routeShapes || {};
            console.log('  GTFS cache loaded: ' + Object.keys(gtfsData.routes).length + ' routes, ' +
                gtfsData.stops.length + ' stops, ' + Object.keys(gtfsData.shapes).length + ' shapes\n');
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

        // Routes
        parseCSV('routes.txt', r => {
            if (r.route_id) {
                if (!r.route_color) r.route_color = '';
                if (!r.route_text_color) r.route_text_color = '';
                gtfsData.routes[r.route_id] = r;
            }
        });

        // Trips
        const tripRoutes = {};
        parseCSV('trips.txt', t => {
            if (t.trip_id && t.route_id) {
                tripRoutes[t.trip_id] = { route_id: t.route_id, headsign: t.trip_headsign || '', direction: t.direction_id || '', shape_id: t.shape_id || '' };
            }
        });

        // Stop times
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

        // Build stopInfo: per stop, unique routes and next arrival times
        Object.keys(stopTimes).forEach(sid => {
            const times = stopTimes[sid];
            // Group by route, pick earliest arrival
            const byRoute = {};
            times.forEach(t => {
                if (!byRoute[t.route_id]) byRoute[t.route_id] = { route_id: t.route_id, arrivals: [], headsign: t.headsign };
                if (t.arrival) byRoute[t.route_id].arrivals.push(t.arrival);
            });
            // Sort arrivals, take next 3
            Object.keys(byRoute).forEach(rid => {
                byRoute[rid].arrivals.sort();
                byRoute[rid].next = byRoute[rid].arrivals.slice(0, 3);
                delete byRoute[rid].arrivals;
            });
            gtfsData.stopInfo[sid] = Object.values(byRoute);
        });

        // Route→Shapes mapping (deduplicated)
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

        // Stops
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

        // Shapes
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

        // Sort shape points by sequence
        Object.keys(gtfsData.shapes).forEach(sid => {
            gtfsData.shapes[sid].sort((a, b) => a.seq - b.seq);
        });

        console.log('  GTFS extracted: ' + Object.keys(gtfsData.routes).length + ' routes, ' +
            gtfsData.stops.length + ' stops, ' + Object.keys(gtfsData.shapes).length + ' shapes\n');
        fs.writeFileSync(CACHE, JSON.stringify(gtfsData));

    } catch (e) {
        console.error('  GTFS error:', e.message);
    }
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(e) {}
}

http.createServer((req, res) => {
    if (req.url === '/api/vehicles') {
        return proxy('https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/VechiclePosition', res);
    }
    if (req.url === '/api/trip-updates') {
        return proxy('https://avl.amtab.it/WSExportGTFS_RT/api/gtfs/TripUpdates', res);
    }
    if (req.url === '/api/routes') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(JSON.stringify(gtfsData.routes));
    }
    if (req.url === '/api/stops') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(JSON.stringify(gtfsData.stops));
    }
    if (req.url === '/api/shapes') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(JSON.stringify(gtfsData.shapes));
    }
    if (req.url === '/api/stop-info') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
        return res.end(JSON.stringify(gtfsData.stopInfo));
    }
    if (req.url === '/api/route-shapes') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
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
});

function proxy(url, res) {
    https.get(url, (proxy) => {
        let body = '';
        proxy.on('data', c => body += c);
        proxy.on('end', () => {
            const ct = proxy.headers['content-type'] || 'application/json; charset=utf-8';
            res.writeHead(proxy.statusCode, { 'Content-Type': ct });
            res.end(body);
        });
    }).on('error', e => {
        res.writeHead(500);
        res.end('Proxy error: ' + e.message);
    });
}
