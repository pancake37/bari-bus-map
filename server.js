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
const DEFAULT_SPEED = 22;
const RUSH_FACTOR = 0.85;
const ETA_MAX_MIN = 120;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.css':  'text/css',
    '.json': 'application/json'
};

let gtfsData = {
    routes: {},
    stops: [],
    shapes: {},
    stopInfo: {},
    routeShapes: {},
    tripShapes: {},
    tripDirections: {},
    shapeStops: {},
    graphs: {},
    stopRoutePos: {},
    stopSequence: {},
    calendar: {},
    calendarDates: {}
};
let vehiclesCache = [], delaysCache = {}, etasCache = {}, otpCache = {};
let histSpeed = {}, obsBuffer = [], obsCount = 0, logStream = null, logDate = '';
// Graceful fallback backup
let lastVehiclesBackup = null, lastDelaysBackup = null, lastBackupTime = 0;
const BACKUP_TTL_MS = 300000; // 5 min
const MAX_OBS_BUFFER_SIZE = 10000;
// Service calendar (populated during extractAll)
let serviceIdMap = {}; // trip_id → service_id

// ── GTFS Cache ───────────────────────────────────────────────────────────────

function loadCache() {
    if (fs.existsSync(CACHE)) {
        try {
            gtfsData = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
            gtfsData.stopInfo = gtfsData.stopInfo || {};
            gtfsData.routeShapes = gtfsData.routeShapes || {};
            gtfsData.tripShapes = gtfsData.tripShapes || {};
            gtfsData.tripDirections = gtfsData.tripDirections || {};
            gtfsData.shapeStops = gtfsData.shapeStops || {};
            gtfsData.calendar = gtfsData.calendar || {};
            gtfsData.calendarDates = gtfsData.calendarDates || {};
            if (!gtfsData.shapeStops || Object.keys(gtfsData.shapeStops).length === 0) {
                console.log('  Cache outdated (missing shapeStops), re-extracting...');
                return false;
            }
            if (!gtfsData.graphs || Object.keys(gtfsData.graphs).length === 0) buildGraphs();
            if (!gtfsData.stopRoutePos || Object.keys(gtfsData.stopRoutePos).length === 0) buildStopRoutePositions();
            if (!gtfsData.stopSequence || Object.keys(gtfsData.stopSequence).length === 0) buildStopSequences();
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

        const parseCSV = (fp, cb) => {
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
        gtfsData.tripShapes = {};
        gtfsData.tripDirections = {};
        serviceIdMap = {};
        parseCSV('trips.txt', t => {
            if (t.trip_id && t.route_id) {
                tripRoutes[t.trip_id] = { route_id: t.route_id, headsign: t.trip_headsign || '', direction: t.direction_id || '', shape_id: t.shape_id || '' };
                gtfsData.tripShapes[t.trip_id] = t.shape_id || '';
                gtfsData.tripDirections[t.trip_id] = t.direction_id || '';
                if (t.service_id) serviceIdMap[t.trip_id] = t.service_id;
            }
        });

        const stopTimes = {};
        const shapeStopsMap = {};
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
                    if (trip.shape_id) {
                        if (!shapeStopsMap[trip.shape_id]) shapeStopsMap[trip.shape_id] = new Set();
                        shapeStopsMap[trip.shape_id].add(st.stop_id);
                    }
                }
            }
        });

        gtfsData.shapeStops = {};
        Object.keys(shapeStopsMap).forEach(shapeId => {
            gtfsData.shapeStops[shapeId] = Array.from(shapeStopsMap[shapeId]);
        });

        // Filter stop times by active services if calendar is available
        const activeSids = Object.keys(gtfsData.calendar).length > 0
            ? getActiveServiceIds(new Date()) : null;
        const filteredStopTimes = {};
        if (activeSids) {
            Object.keys(stopTimes).forEach(sid => {
                filteredStopTimes[sid] = stopTimes[sid].filter(t => {
                    const tid = Object.keys(tripRoutes).find(
                        k => tripRoutes[k].route_id === t.route_id
                    );
                    return tid && activeSids.has(serviceIdMap[tid]);
                });
            });
        } else {
            Object.assign(filteredStopTimes, stopTimes);
        }

        Object.keys(filteredStopTimes).forEach(sid => {
            const times = filteredStopTimes[sid];
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
            if (activeSids && !activeSids.has(serviceIdMap[tid])) return;
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

        // ── Calendar parsing (calendar.txt + calendar_dates.txt) ──────────
        gtfsData.calendar = {};
        gtfsData.calendarDates = {};
        parseCSV('calendar.txt', c => {
            if (c.service_id) {
                gtfsData.calendar[c.service_id] = {
                    monday: c.monday, tuesday: c.tuesday, wednesday: c.wednesday,
                    thursday: c.thursday, friday: c.friday, saturday: c.saturday, sunday: c.sunday,
                    start_date: c.start_date, end_date: c.end_date
                };
            }
        });
        parseCSV('calendar_dates.txt', cd => {
            if (cd.service_id && cd.date) {
                gtfsData.calendarDates[cd.service_id + '|' + cd.date] = cd.exception_type;
            }
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

// ── Service Calendar ─────────────────────────────────────────────────────────

function getActiveServiceIds(date) {
    const active = new Set();
    const dateStr = date.toISOString().substring(0, 10).replace(/-/g, '');
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[date.getDay()];

    Object.keys(gtfsData.calendar).forEach(serviceId => {
        const c = gtfsData.calendar[serviceId];
        if (c[dayName] === '1' && dateStr >= c.start_date && dateStr <= c.end_date) {
            active.add(serviceId);
        }
    });

    Object.keys(gtfsData.calendarDates).forEach(key => {
        const [serviceId, excDate] = key.split('|');
        if (excDate === dateStr) {
            if (gtfsData.calendarDates[key] === '1') active.add(serviceId);
            else if (gtfsData.calendarDates[key] === '2') active.delete(serviceId);
        }
    });

    return active;
}

function recomputeActiveServices() {
    if (Object.keys(gtfsData.calendar).length === 0) return;
    const today = new Date();
    const activeSids = getActiveServiceIds(today);

    // Filter routeShapes: only keep shapes from active service trips
    const trips = gtfsData.tripShapes;
    Object.keys(gtfsData.routeShapes).forEach(routeId => {
        gtfsData.routeShapes[routeId] = gtfsData.routeShapes[routeId].filter(shapeId => {
            return Object.keys(trips).some(
                tid => trips[tid] === shapeId && activeSids.has(serviceIdMap[tid])
            );
        });
    });

    console.log('  Service calendar recomputed: ' + activeSids.size + ' active services\n');
}

function refreshGtfsStatic() {
    console.log('  Periodic GTFS refresh...');
    try {
        extractAll();
        console.log('  GTFS refresh complete: ' + Object.keys(gtfsData.routes).length + ' routes\n');
    } catch (e) {
        console.error('  GTFS refresh error:', e.message);
    }
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
    
    Object.keys(gtfsData.shapes).forEach(shapeId => {
        const edges = gtfsData.graphs[shapeId];
        if (!edges) return;
        
        gtfsData.stopRoutePos[shapeId] = {};
        
        const stopIds = gtfsData.shapeStops[shapeId] || [];
        stopIds.forEach(sid => {
            const s = stopMap[sid];
            if (!s) return;
            gtfsData.stopRoutePos[shapeId][sid] = projectToGraph(s.lat, s.lon, edges);
        });
    });
}

function buildStopSequences() {
    gtfsData.stopSequence = {};
    Object.keys(gtfsData.stopRoutePos).forEach(shapeId => {
        const stops = gtfsData.stopRoutePos[shapeId];
        gtfsData.stopSequence[shapeId] = Object.keys(stops).sort((a, b) => stops[a] - stops[b]);
    });
}

// ── Encoded Polyline (Google-style) ──────────────────────────────────────────

function encodePolylineSigned(value) {
    let current = value < 0 ? ~(value << 1) : value << 1;
    let output = '';
    while (current >= 0x20) {
        output += String.fromCharCode((0x20 | (current & 0x1f)) + 63);
        current >>= 5;
    }
    return output + String.fromCharCode(current + 63);
}

function encodeShapePolyline(pts) {
    if (!pts || !pts.length) return '';
    let prevLat = 0, prevLon = 0, out = '';
    const PREC = 100000;
    for (const p of pts) {
        const lat = Math.round(p.lat * PREC);
        const lon = Math.round(p.lon * PREC);
        out += encodePolylineSigned(lat - prevLat);
        out += encodePolylineSigned(lon - prevLon);
        prevLat = lat; prevLon = lon;
    }
    return out;
}

function decodePolylineSigned(val) {
    return val & 1 ? ~(val >> 1) : val >> 1;
}

function decodeShapePolyline(str) {
    const pts = [];
    let prevLat = 0, prevLon = 0, idx = 0;
    const PREC = 100000;
    while (idx < str.length) {
        let res = 0, shift = 0, byte;
        do { byte = str.charCodeAt(idx++) - 63; res |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        prevLat += decodePolylineSigned(res);
        res = 0; shift = 0;
        do { byte = str.charCodeAt(idx++) - 63; res |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20);
        prevLon += decodePolylineSigned(res);
        pts.push({ lat: prevLat / PREC, lon: prevLon / PREC });
    }
    return pts;
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateVehicle(v) {
    if (!v || typeof v !== 'object') return false;
    if (typeof v.lat !== 'number' || typeof v.lon !== 'number') return false;
    if (isNaN(v.lat) || isNaN(v.lon)) return false;
    if (v.lat < 40 || v.lat > 42 || v.lon < 16 || v.lon > 18) return false;
    if (!v.rid && !v.tid) return false;
    return true;
}

// ── Feature Extraction (2024 Paper) ──────────────────────────────────────────

function isRushHour(h) { return (h >= RUSH_START && h < RUSH_END) || (h >= RUSH_START2 && h < RUSH_END2); }
function isWeekend(d) { return d === 0 || d === 6; }
function timeBlock(h) { return Math.floor(h / 2) * 2; }

function extractFeatures(v, vehCum, nextStopId) {
    const now = new Date();
    const h = now.getHours(), dow = now.getDay();
    
    const shapeId = gtfsData.tripShapes[v.tid] || (gtfsData.routeShapes[v.rid] && gtfsData.routeShapes[v.rid][0]);
    if (!shapeId) return null;
    
    const stops = gtfsData.stopRoutePos[shapeId];
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
        spd_mps: v.spd / 3.6,
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
    if (obsBuffer.length >= MAX_OBS_BUFFER_SIZE) {
        const excess = obsBuffer.length - MAX_OBS_BUFFER_SIZE;
        obsBuffer.splice(0, excess);
    }
    if (obsBuffer.length >= 100) flushLogs();
}

function sweepObsBuffer() {
    if (obsBuffer.length > MAX_OBS_BUFFER_SIZE) {
        obsBuffer.splice(0, obsBuffer.length - MAX_OBS_BUFFER_SIZE);
    }
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
    return h ? Math.max(h.avg, 16) : DEFAULT_SPEED;
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

const OTP_EARLY_S = -60;
const OTP_LATE_S = 300;

function computeOTP() {
    const otp = {};
    vehiclesCache.forEach(v => {
        if (!otp[v.rid]) otp[v.rid] = { total: 0, onTime: 0 };
        otp[v.rid].total++;
        const delay = delaysCache[v.tid] || 0;
        if (delay >= OTP_EARLY_S && delay <= OTP_LATE_S) otp[v.rid].onTime++;
    });
    Object.keys(otp).forEach(rid => {
        otp[rid].otpPct = Math.round(otp[rid].onTime / otp[rid].total * 100);
    });
    return otp;
}

function pollRealtime() {
    let pending = 2;
    function done() { if (--pending === 0) { otpCache = computeOTP(); computeETAs(); flushLogs(); sweepObsBuffer(); } }

    fetchJSON(AMTAB_VEH, (err, vehData) => {
        if (!err && vehData) {
            const vehicles = [];
            (vehData.Entity || vehData.Entities || []).forEach(e => {
                const veh = e.Vehicle;
                if (!veh || !veh.Position) return;
                const rid = (veh.Trip && veh.Trip.RouteId) || '';
                const tid = (veh.Trip && veh.Trip.TripId) || '';
                const shapeId = gtfsData.tripShapes[tid] || (gtfsData.routeShapes[rid] && gtfsData.routeShapes[rid][0]) || '';
                const v = {
                    id: e.Id, rid, tid,
                    lat: veh.Position.Latitude, lon: veh.Position.Longitude,
                    spd: veh.Position.Speed || 0,
                    shapeId,
                    stopId: veh.StopId || null,
                    currentStopSequence: veh.CurrentStopSequence || null,
                    currentStatus: veh.CurrentStatus !== undefined ? veh.CurrentStatus : null,
                    vehicleId: (veh.Vehicle && veh.Vehicle.Id) || null,
                    vehicleLabel: (veh.Vehicle && veh.Vehicle.Label) || null,
                    timestamp: veh.Timestamp || null,
                    congestionLevel: veh.congestion_level !== undefined ? veh.congestion_level : null
                };
                if (validateVehicle(v)) vehicles.push(v);
            });
            vehiclesCache = vehicles;
            lastVehiclesBackup = { data: vehicles, ts: Date.now() };
        } else {
            if (lastVehiclesBackup && (Date.now() - lastVehiclesBackup.ts) < BACKUP_TTL_MS) {
                const age = Math.round((Date.now() - lastVehiclesBackup.ts) / 1000);
                vehiclesCache = lastVehiclesBackup.data;
            }
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
            lastDelaysBackup = { data: d, ts: Date.now() };
        } else {
            if (lastDelaysBackup && (Date.now() - lastDelaysBackup.ts) < BACKUP_TTL_MS) {
                delaysCache = lastDelaysBackup.data;
            }
        }
        done();
    });
}

function computeETAs() {
    const etas = {};
    const now = new Date();
    const h = now.getHours(), block = timeBlock(h);

    vehiclesCache.forEach(v => {
        const shapeId = gtfsData.tripShapes[v.tid] || (gtfsData.routeShapes[v.rid] && gtfsData.routeShapes[v.rid][0]);
        if (!shapeId) return;
        const edges = gtfsData.graphs[shapeId];
        if (!edges) return;
        const vehCum = projectToGraph(v.lat, v.lon, edges);
        const stops = gtfsData.stopRoutePos[shapeId];
        if (!stops) return;

        // Find next stop and log feature
        const seq = gtfsData.stopSequence[shapeId] || [];
        let nextStopId = null;
        let nextStopIdx = -1;

        if (v.stopId && seq.indexOf(v.stopId) !== -1) {
            const stopIdx = seq.indexOf(v.stopId);
            if (v.currentStatus === 1) { // STOPPED_AT
                if (stopIdx + 1 < seq.length) {
                    nextStopId = seq[stopIdx + 1];
                    nextStopIdx = stopIdx + 1;
                }
            } else { // IN_TRANSIT_TO (0) or INCOMING_AT (2)
                nextStopId = v.stopId;
                nextStopIdx = stopIdx;
            }
        }

        if (!nextStopId) {
            for (let i = 0; i < seq.length; i++) {
                if (vehCum < stops[seq[i]]) {
                    nextStopId = seq[i];
                    nextStopIdx = i;
                    break;
                }
            }
        }

        const feat = extractFeatures({ ...v }, vehCum, nextStopId);
        if (feat) logObservation(feat);

        if (!nextStopId) return; // Bus has passed all stops on this shape

        // Calculate current segment distances for weighted speed
        const prevStopDist = nextStopIdx > 0 ? stops[seq[nextStopIdx - 1]] : 0;
        const nextStopDist = stops[nextStopId];

        const Sib = Math.max(0, vehCum - prevStopDist);
        const Sif = Math.max(0, nextStopDist - vehCum);

        const vr = v.spd;
        const vai = getVai(v.rid, block);

        // Weighted speed: closer to stop → more weight on current speed vr.
        // Weight of vr is Sib (distance from start of segment). Weight of vai is Sif (distance to next stop).
        const vi = (Sib + Sif > 0) ? (Sib * vr + Sif * vai) / (Sib + Sif) : vai;

        // Apply rush hour factor
        const rushFactor = feat && feat.rush ? RUSH_FACTOR : 1;
        // Apply far status: if close to stop, reduce speed (bus slowing down)
        const farFactor = feat && !feat.far ? 0.7 : 1;

        // Travel speed and time on current segment
        const finalCurrentSpeed = Math.max(vi * rushFactor * farFactor, 3);
        const tCurrent = Sif / finalCurrentSpeed; // travel time to next stop in hours

        // Compute ETA for all downstream stops
        Object.keys(stops).forEach(sid => {
            if (vehCum >= stops[sid]) return;

            let etaHrs = 0;
            if (sid === nextStopId) {
                etaHrs = tCurrent;
            } else if (stops[sid] > nextStopDist) {
                // For downstream stops, remaining distance from next stop to sid is covered at historical speed (adjusted for rush hour)
                const distFromNextStop = stops[sid] - nextStopDist;
                const downstreamSpeed = Math.max(vai * rushFactor, 3);
                etaHrs = tCurrent + distFromNextStop / downstreamSpeed;
            } else {
                return;
            }

            const eta = Math.round(etaHrs * 60);
            if (eta > ETA_MAX_MIN) return;
            if (!etas[sid]) etas[sid] = {};
            if (!etas[sid][v.rid] || eta < etas[sid][v.rid].eta) {
                // Confidence: compare geometric nextStopIdx with RT currentStopSequence
                let confidence = 'high';
                if (v.currentStopSequence != null && nextStopIdx >= 0) {
                    const diff = Math.abs(nextStopIdx - v.currentStopSequence);
                    if (diff > 1) confidence = 'low';
                }
                etas[sid][v.rid] = { eta, delay: delaysCache[v.tid] || 0, vid: v.id, confidence };
            }
        });

        // Update historical speed for the route
        if (v.spd > 10) updateVai(v.rid, block, v.spd);
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
    // Sweep stale obs buffer every 2 min
    setInterval(sweepObsBuffer, 120000);
    // Recompute active services at midnight (every 60s check)
    setInterval(() => {
        const now = new Date();
        if (now.getHours() === 0 && now.getMinutes() === 0) recomputeActiveServices();
    }, 60000);
    // Refresh GTFS static every 24 hours
    setInterval(refreshGtfsStatic, 86400000);
}

// ── Server ───────────────────────────────────────────────────────────────────

http.createServer((req, res) => {
    const staticHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' };
    const dynamicHead = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0' };
    const url = req.url;

    if (url === '/api/vehicles') {
        res.writeHead(200, dynamicHead);
        return res.end(JSON.stringify(vehiclesCache));
    }
    if (url === '/api/trip-updates') {
        res.writeHead(200, dynamicHead);
        return res.end(JSON.stringify(delaysCache));
    }
    if (url === '/api/etas') {
        // Response: { [stopId]: { [routeId]: { eta, delay, vid, confidence } } }
        // confidence: 'high' (geometric + RT match) | 'low' (geometric and RT disagree by >1 stop)
        res.writeHead(200, dynamicHead);
        return res.end(JSON.stringify(etasCache));
    }
    if (url === '/api/routes') {
        res.writeHead(200, staticHead);
        return res.end(JSON.stringify(gtfsData.routes));
    }
    if (url === '/api/stops') {
        res.writeHead(200, staticHead);
        return res.end(JSON.stringify(gtfsData.stops));
    }
    if (url.startsWith('/api/shapes')) {
        const u = new URL(url, 'http://localhost');
        const id = u.searchParams.get('id');
        const encoded = u.searchParams.get('encoded') === '1';
        res.writeHead(200, encoded ? Object.assign({}, staticHead, { 'Content-Type': 'text/plain; charset=utf-8' }) : staticHead);
        if (id) {
            const sh = gtfsData.shapes[id];
            if (!sh) return res.end('[]');
            if (encoded) return res.end(encodeShapePolyline(sh));
            return res.end(JSON.stringify(sh));
        } else {
            return res.end(JSON.stringify(gtfsData.shapes));
        }
    }
    if (url === '/api/stop-info') {
        res.writeHead(200, staticHead);
        return res.end(JSON.stringify(gtfsData.stopInfo));
    }
    if (url === '/api/route-shapes') {
        res.writeHead(200, staticHead);
        return res.end(JSON.stringify(gtfsData.routeShapes));
    }
    if (url === '/api/shape-stops') {
        res.writeHead(200, staticHead);
        return res.end(JSON.stringify(gtfsData.stopSequence));
    }
    if (url === '/api/otp') {
        res.writeHead(200, dynamicHead);
        return res.end(JSON.stringify(otpCache));
    }
    if (url === '/api/stats') {
        res.writeHead(200, dynamicHead);
        return res.end(JSON.stringify({
            vehicles: vehiclesCache.length,
            etasStops: Object.keys(etasCache).length,
            obsToday: obsCount,
            histRoutes: Object.keys(histSpeed).length,
            logDate
        }));
    }

    const pathname = new URL(url, 'http://localhost').pathname;
    const file = path.resolve(__dirname, pathname === '/' ? 'index.html' : pathname.substring(1));
    const relative = path.relative(__dirname, file);
    const isSafe = !relative.startsWith('..') && !path.isAbsolute(relative);

    if (!isSafe) {
        res.writeHead(403);
        return res.end('Forbidden');
    }

    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(file);
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
        if (ext === '.html' || ext === '.js' || ext === '.css') {
            headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
        }
        res.writeHead(200, headers);
        res.end(data);
    });
}).listen(PORT, () => {
    console.log('\n  🚌  Bari AMTAB Bus Map');
    console.log('  Open: http://localhost:' + PORT + '\n');
    if (!loadCache()) extractAll();
    initRealtime();
});

process.on('uncaughtException', err => {
    console.error('[AMTAB Server] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[AMTAB Server] Unhandled Rejection at:', promise, 'reason:', reason);
});
