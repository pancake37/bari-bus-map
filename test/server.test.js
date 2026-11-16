'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const TEST_PORT = 34567;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

function fetch(urlPath, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE_URL + urlPath, {
            method: options.method || 'GET',
            headers: options.headers || {}
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body,
                    text: () => body.toString('utf8'),
                    json: () => JSON.parse(body.toString('utf8'))
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

function waitForReady(timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function check() {
            fetch('/api/status')
                .then(res => {
                    if (res.status === 200) resolve();
                    else retry();
                })
                .catch(retry);
        }
        function retry() {
            if (Date.now() - start > timeoutMs) {
                return reject(new Error('Server did not become ready within timeout'));
            }
            setTimeout(check, 250);
        }
        check();
    });
}

describe('server endpoints and security', () => {
    let serverProcess;

    before(async () => {
        serverProcess = spawn(process.execPath, ['server.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: Object.assign({}, process.env, { PORT: String(TEST_PORT) }),
            stdio: ['ignore', 'pipe', 'pipe']
        });
        await waitForReady();
    });

    after(() => {
        if (serverProcess) {
            serverProcess.kill('SIGTERM');
        }
    });

    describe('static pages and routing', () => {
        it('serves canvas map at root /', async () => {
            const res = await fetch('/');
            assert.equal(res.status, 200);
            assert.ok(res.headers['content-type'].includes('text/html'));
            assert.ok(res.text().includes('map-shell') || res.text().includes('canvas id="map"'));
        });

        it('serves canvas map at /mobilita and /mobilita/', async () => {
            const res1 = await fetch('/mobilita');
            assert.equal(res1.status, 200);
            const res2 = await fetch('/mobilita/');
            assert.equal(res2.status, 200);
        });

        it('serves legacy leaflet app at /realtime and /realtime/', async () => {
            const res = await fetch('/realtime');
            assert.equal(res.status, 200);
            assert.ok(res.headers['content-type'].includes('text/html'));
            assert.ok(res.text().includes('leaflet'));
        });

        it('serves static assets with correct MIME type', async () => {
            const res = await fetch('/assets/favicon.svg');
            assert.equal(res.status, 200);
            assert.ok(res.headers['content-type'].includes('image/svg+xml'));
        });
    });

    describe('REST API endpoints', () => {
        it('/api/status reports status and health', async () => {
            const res = await fetch('/api/status');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.equal(typeof data.pollInProgress, 'boolean');
            assert.equal(typeof data.vehiclesStale, 'boolean');
        });

        it('/api/stats returns runtime statistics', async () => {
            const res = await fetch('/api/stats');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.equal(typeof data.vehicles, 'number');
            assert.equal(typeof data.etasStops, 'number');
        });

        it('/api/routes returns GTFS routes', async () => {
            const res = await fetch('/api/routes');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(Object.keys(data).length > 0);
        });

        it('/api/stops returns GTFS stops', async () => {
            const res = await fetch('/api/stops');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(Object.keys(data).length > 100);
        });

        it('/api/route-shapes returns route to shapes mapping', async () => {
            const res = await fetch('/api/route-shapes');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(typeof data === 'object');
        });

        it('/api/shape-stops returns shape stop sequence mapping', async () => {
            const res = await fetch('/api/shape-stops');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(typeof data === 'object');
        });

        it('/api/shapes returns all shapes and single shape by id', async () => {
            const allRes = await fetch('/api/shapes');
            assert.equal(allRes.status, 200);
            const allShapes = allRes.json();
            const shapeIds = Object.keys(allShapes);
            assert.ok(shapeIds.length > 0);

            const testId = shapeIds[0];
            const singleRes = await fetch(`/api/shapes?id=${encodeURIComponent(testId)}`);
            assert.equal(singleRes.status, 200);
            const shapePoints = singleRes.json();
            assert.ok(Array.isArray(shapePoints));
            assert.ok(shapePoints.length > 0);

            const encodedRes = await fetch(`/api/shapes?id=${encodeURIComponent(testId)}&encoded=1`);
            assert.equal(encodedRes.status, 200);
            assert.ok(typeof encodedRes.text() === 'string');
            assert.ok(encodedRes.text().length > 0);
        });

        it('/api/vehicles returns real-time vehicles array', async () => {
            const res = await fetch('/api/vehicles');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(Array.isArray(data));
        });

        it('/api/trip-updates returns delay dictionary', async () => {
            const res = await fetch('/api/trip-updates');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(typeof data === 'object');
        });

        it('/api/etas returns ETA dictionary', async () => {
            const res = await fetch('/api/etas');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(typeof data === 'object');
        });

        it('/api/otp returns OTP cache', async () => {
            const res = await fetch('/api/otp');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(typeof data === 'object');
        });

        it('/api/trip-detail handles queries cleanly', async () => {
            const res = await fetch('/api/trip-detail?tripId=nonexistent');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.equal(data.tripId, 'nonexistent');
            assert.ok(typeof data.stops === 'object' && data.stops !== null);
        });

        it('/api/stop-timetable handles queries cleanly', async () => {
            const res = await fetch('/api/stop-timetable?stopId=nonexistent');
            assert.equal(res.status, 200);
            const data = res.json();
            assert.ok(Array.isArray(data));
        });

        it('serves static GTFS API endpoints with pre-compressed gzip buffer and ETag', async () => {
            const endpoints = ['/api/routes', '/api/stops', '/api/shape-stops', '/api/stop-info', '/api/shapes'];
            for (const ep of endpoints) {
                // With gzip accept header
                const resGzip = await fetch(ep, { headers: { 'accept-encoding': 'gzip' } });
                assert.equal(resGzip.status, 200, `${ep} should return 200`);
                assert.equal(resGzip.headers['content-encoding'], 'gzip', `${ep} should have content-encoding: gzip`);
                assert.ok(resGzip.headers['etag'], `${ep} should include ETag`);

                // 304 conditional request
                const etag = resGzip.headers['etag'];
                const res304 = await fetch(ep, { headers: { 'if-none-match': etag } });
                assert.equal(res304.status, 304, `${ep} with If-None-Match should return 304`);
            }
        });

        it('serves static .gz files with Content-Encoding gzip when accepted', async () => {
            const gzPath = '/mobilita/cities/bari-5365bda2a696bd4a08e39828f06e6d43dbb8f807814337d1ec8aa1687e1fe66a.json.gz';
            const res = await fetch(gzPath, { headers: { 'accept-encoding': 'gzip' } });
            assert.equal(res.status, 200);
            assert.equal(res.headers['content-encoding'], 'gzip');
            assert.ok(res.headers['content-type'].includes('application/json') || res.headers['content-type'].includes('application/gzip'));
            assert.ok(res.headers['etag']);

            // Test 304 on static gz
            const res304 = await fetch(gzPath, { headers: { 'if-none-match': res.headers['etag'] } });
            assert.equal(res304.status, 304);
        });

        it('serves static .json.gz decompressed with application/json when gzip is not accepted', async () => {
            const gzPath = '/mobilita/cities/bari-5365bda2a696bd4a08e39828f06e6d43dbb8f807814337d1ec8aa1687e1fe66a.json.gz';
            const res = await fetch(gzPath, { headers: { 'accept-encoding': 'identity' } });
            assert.equal(res.status, 200);
            assert.equal(res.headers['content-encoding'], undefined);
            assert.ok(res.headers['content-type'].includes('application/json'));
            const parsed = res.json();
            assert.ok(typeof parsed === 'object' && parsed !== null);
            assert.equal(parsed.id, 'bari');
            assert.ok(Array.isArray(parsed.stops));
            assert.ok(parsed.stops.length > 0);

            // Test 304 on uncompressed asset
            const res304 = await fetch(gzPath, { headers: { 'accept-encoding': 'identity', 'if-none-match': res.headers['etag'] } });
            assert.equal(res304.status, 304);
        });
    });

    describe('security and access control', () => {
        it('blocks access to server.js', async () => {
            const res = await fetch('/server.js');
            assert.equal(res.status, 403);
        });

        it('blocks access to .gtfs-cache.json', async () => {
            const res = await fetch('/.gtfs-cache.json');
            assert.equal(res.status, 403);
        });

        it('blocks access to .git contents', async () => {
            const res = await fetch('/.git/config');
            assert.equal(res.status, 403);
        });

        it('blocks access to google_transit.zip', async () => {
            const res = await fetch('/google_transit.zip');
            assert.equal(res.status, 403);
        });

        it('blocks access to package.json', async () => {
            const res = await fetch('/package.json');
            assert.equal(res.status, 403);
        });

        it('blocks path traversal attempts (../)', async () => {
            const res1 = await fetch('/../server.js');
            assert.equal(res1.status, 403);

            const res2 = await fetch('/assets/../../server.js');
            assert.equal(res2.status, 403);

            const res3 = await fetch('/mobilita/../../server.js');
            assert.equal(res3.status, 403);
        });

        it('blocks unauthorized extensions under assets or mobilita', async () => {
            const res = await fetch('/assets/secret.env');
            assert.equal(res.status, 403);
        });

        it('returns 404 for missing static file with permitted extension', async () => {
            const res = await fetch('/assets/missing-image.png');
            assert.equal(res.status, 404);
        });
    });
});

describe('cold-start and GTFS cache extraction lifecycle', () => {
    let coldServer;
    const COLD_PORT = 34568;
    const coldUrl = `http://127.0.0.1:${COLD_PORT}`;
    const tmpCacheFile = path.join(os.tmpdir(), `gtfs-cold-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

    function coldFetch(urlPath, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request(coldUrl + urlPath, {
                method: options.method || 'GET',
                headers: options.headers || {}
            }, res => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    const body = Buffer.concat(chunks);
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body,
                        text: () => body.toString('utf8'),
                        json: () => JSON.parse(body.toString('utf8'))
                    });
                });
            });
            req.on('error', reject);
            req.end();
        });
    }

    before(async () => {
        if (fs.existsSync(tmpCacheFile)) fs.unlinkSync(tmpCacheFile);

        coldServer = spawn(process.execPath, ['server.js'], {
            cwd: path.resolve(__dirname, '..'),
            env: Object.assign({}, process.env, {
                PORT: String(COLD_PORT),
                GTFS_CACHE_FILE: tmpCacheFile
            }),
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const start = Date.now();
        await new Promise((resolve, reject) => {
            function check() {
                coldFetch('/api/status')
                    .then(res => {
                        if (res.status === 200) resolve();
                        else retry();
                    })
                    .catch(retry);
            }
            function retry() {
                if (Date.now() - start > 20000) {
                    return reject(new Error('Cold-start server did not become ready within timeout'));
                }
                setTimeout(check, 300);
            }
            check();
        });
    });

    after(() => {
        if (coldServer) {
            coldServer.kill('SIGTERM');
        }
        try {
            if (fs.existsSync(tmpCacheFile)) fs.unlinkSync(tmpCacheFile);
        } catch (_) {}
    });

    it('populates static API cache on cold extraction without prior cache file', async () => {
        const stopsRes = await coldFetch('/api/stops');
        assert.equal(stopsRes.status, 200);
        const stops = stopsRes.json();
        assert.ok(Array.isArray(stops));
        assert.equal(stops.length, 1119, 'Cold-start /api/stops should return exactly 1,119 stops');

        const shapesRes = await coldFetch('/api/shapes');
        assert.equal(shapesRes.status, 200);
        const shapes = shapesRes.json();
        assert.ok(typeof shapes === 'object' && shapes !== null);
        const shapeCount = Object.keys(shapes).length;
        assert.ok(shapeCount >= 81, `Cold-start /api/shapes should return at least 81 shapes (got ${shapeCount})`);
        assert.equal(shapeCount, 203, 'Cold-start /api/shapes should return 203 shapes matching GTFS feed');

        const shapeStopsRes = await coldFetch('/api/shape-stops');
        assert.equal(shapeStopsRes.status, 200);
        const shapeStops = shapeStopsRes.json();
        assert.ok(typeof shapeStops === 'object' && shapeStops !== null);
        assert.ok(Object.keys(shapeStops).length > 0, 'Cold-start /api/shape-stops must not be empty');

        const routesRes = await coldFetch('/api/routes');
        assert.equal(routesRes.status, 200);
        const routes = routesRes.json();
        assert.ok(typeof routes === 'object' && routes !== null);
        assert.equal(Object.keys(routes).length, 82, 'Cold-start /api/routes should return 82 routes');

        const stopsGzip = await coldFetch('/api/stops', { headers: { 'accept-encoding': 'gzip' } });
        assert.equal(stopsGzip.status, 200);
        assert.equal(stopsGzip.headers['content-encoding'], 'gzip');
        assert.ok(stopsGzip.headers['etag']);

        const stops304 = await coldFetch('/api/stops', { headers: { 'if-none-match': stopsGzip.headers['etag'] } });
        assert.equal(stops304.status, 304);
    });
});
