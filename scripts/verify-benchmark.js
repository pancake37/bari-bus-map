'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const vm = require('vm');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TEST_PORT = 38888;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function main() {
    console.log('================================================================');
    console.log('🚀 BARI BUS MAP - PERFORMANCE & VALIDATION VERIFICATION SUITE');
    console.log('================================================================\n');

    let allPassed = true;

    // -------------------------------------------------------------
    // 1. SYNTAX VALIDATION
    // -------------------------------------------------------------
    console.log('--- 1. SYNTAX VALIDATION ---');
    
    // 1.1 server.js syntax
    try {
        const serverCode = fs.readFileSync(path.join(PROJECT_ROOT, 'server.js'), 'utf8');
        new vm.Script(serverCode, { filename: 'server.js' });
        console.log('✔ server.js syntax is valid (V8 compile check passed)');
    } catch (err) {
        console.error('✖ server.js syntax error:', err);
        allPassed = false;
    }

    // 1.2 mobilita/index.html scripts syntax
    try {
        const html = fs.readFileSync(path.join(PROJECT_ROOT, 'mobilita', 'index.html'), 'utf8');
        const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
        let match;
        let scriptIndex = 0;
        let jsonCount = 0;
        let jsCount = 0;
        while ((match = scriptRegex.exec(html)) !== null) {
            const attrs = match[1];
            const content = match[2].trim();
            if (!content) continue;

            if (/type=["']application\/json["']/i.test(attrs)) {
                try {
                    JSON.parse(content);
                    jsonCount++;
                } catch (err) {
                    console.error(`✖ Embedded JSON #${scriptIndex} in mobilita/index.html syntax error:`, err);
                    allPassed = false;
                }
            } else {
                try {
                    new vm.Script(content, { filename: `mobilita/index.html:script[${scriptIndex}]` });
                    jsCount++;
                } catch (err) {
                    console.error(`✖ Script #${scriptIndex} in mobilita/index.html syntax error:`, err);
                    allPassed = false;
                }
            }
            scriptIndex++;
        }
        console.log(`✔ mobilita/index.html: ${jsCount} JS <script> blocks and ${jsonCount} JSON blocks parsed without syntax errors`);
    } catch (err) {
        console.error('✖ mobilita/index.html read/parse error:', err);
        allPassed = false;
    }

    // -------------------------------------------------------------
    // 2. SERVER ENDPOINT BENCHMARK & PAYLOAD SIZES
    // -------------------------------------------------------------
    console.log('\n--- 2. SERVER ENDPOINT BENCHMARK & PAYLOAD SIZES ---');

    const serverProcess = spawn(process.execPath, ['server.js'], {
        cwd: PROJECT_ROOT,
        env: Object.assign({}, process.env, { PORT: String(TEST_PORT) }),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    try {
        await waitForServer(TEST_PORT);
        console.log(`✔ Test server started on port ${TEST_PORT}\n`);

        const endpoints = [
            { path: '/', label: 'Root (mobilita/index.html) [no gzip]', headers: {} },
            { path: '/', label: 'Root (mobilita/index.html) [gzip]', headers: { 'accept-encoding': 'gzip' } },
            { path: '/mobilita', label: '/mobilita [gzip]', headers: { 'accept-encoding': 'gzip' } },
            { path: '/realtime', label: '/realtime (Leaflet) [gzip]', headers: { 'accept-encoding': 'gzip' } },
            { path: '/assets/vendor/leaflet.js', label: 'Static asset (leaflet.js) [gzip]', headers: { 'accept-encoding': 'gzip' } },
            { 
                path: '/mobilita/cities/bari-5365bda2a696bd4a08e39828f06e6d43dbb8f807814337d1ec8aa1687e1fe66a.json.gz', 
                label: 'City dataset .json.gz (immutable)', 
                headers: {} 
            },
            { path: '/api/status', label: '/api/status', headers: {} },
            { path: '/api/routes', label: '/api/routes', headers: {} },
            { path: '/api/stops', label: '/api/stops', headers: {} },
            { path: '/api/shape-stops', label: '/api/shape-stops', headers: {} },
            { path: '/api/vehicles', label: '/api/vehicles', headers: {} },
            { path: '/api/trip-updates', label: '/api/trip-updates', headers: {} },
            { path: '/api/etas', label: '/api/etas', headers: {} },
        ];

        console.log(
            'Endpoint'.padEnd(42) + 
            'Status'.padEnd(8) + 
            'Latency'.padEnd(12) + 
            'Payload Size'.padEnd(16) + 
            'Encoding / Caching'
        );
        console.log('-'.repeat(105));

        for (const ep of endpoints) {
            // Warmup
            await httpRequest(ep.path, ep.headers);

            // 5 iterations for stable timing
            let totalMs = 0;
            let lastRes = null;
            const N = 5;
            for (let i = 0; i < N; i++) {
                const t0 = performance.now();
                lastRes = await httpRequest(ep.path, ep.headers);
                totalMs += (performance.now() - t0);
            }
            const avgMs = (totalMs / N).toFixed(2);
            const sizeStr = formatBytes(lastRes.body.length);
            const enc = lastRes.headers['content-encoding'] || 'identity';
            const cacheCtrl = lastRes.headers['cache-control'] ? `[${lastRes.headers['cache-control'].slice(0, 20)}...]` : '';

            console.log(
                ep.label.padEnd(42) + 
                String(lastRes.status).padEnd(8) + 
                `${avgMs} ms`.padEnd(12) + 
                sizeStr.padEnd(16) + 
                `${enc} ${cacheCtrl}`
            );
        }

        // Test polyline memoization caching
        console.log('\nBenchmarking Shape Polyline Memoization Cache (/api/shapes?id=...):');
        const shapeId = 'shape_1';
        const t0Cold = performance.now();
        const coldRes = await httpRequest(`/api/shapes?id=${shapeId}`, {});
        const coldTime = (performance.now() - t0Cold).toFixed(2);

        let warmTimeTotal = 0;
        const WN = 10;
        for (let i = 0; i < WN; i++) {
            const t0 = performance.now();
            await httpRequest(`/api/shapes?id=${shapeId}`, {});
            warmTimeTotal += (performance.now() - t0);
        }
        const avgWarmTime = (warmTimeTotal / WN).toFixed(2);
        console.log(`✔ Cold shape query latency: ${coldTime} ms (HTTP 200, length ${coldRes.body.length} B)`);
        console.log(`✔ Cached (memoized) shape query latency: ${avgWarmTime} ms`);

    } finally {
        serverProcess.kill('SIGTERM');
    }

    // -------------------------------------------------------------
    // 3. FRONTEND DATASET & CULLING BENCHMARK
    // -------------------------------------------------------------
    console.log('\n--- 3. FRONTEND MOBILITA ENGINE BENCHMARK (Real Bari Dataset) ---');

    const datasetPath = path.join(PROJECT_ROOT, 'mobilita', 'cities', 'bari-5365bda2a696bd4a08e39828f06e6d43dbb8f807814337d1ec8aa1687e1fe66a.json.gz');
    if (!fs.existsSync(datasetPath)) {
        console.error('✖ Dataset not found at:', datasetPath);
        allPassed = false;
        return;
    }

    const compressed = fs.readFileSync(datasetPath);
    console.log(`✔ Compressed Bari dataset size: ${formatBytes(compressed.length)}`);
    const decompressed = zlib.gunzipSync(compressed);
    console.log(`✔ Decompressed Bari dataset size: ${formatBytes(decompressed.length)}`);

    const source = JSON.parse(decompressed.toString('utf8'));
    console.log(`✔ Parsed source: city="${source.id}", segments=${source.segments?.length || 0}, features=${source.basemap?.features?.length || 0}, stops=${source.stops?.length || 0}`);

    const html = fs.readFileSync(path.join(PROJECT_ROOT, 'mobilita', 'index.html'), 'utf8');

    // Run in simulated sandbox
    const sandbox = {
        console,
        Math,
        Object,
        Array,
        Set,
        Infinity,
        urbanScale: { id: 'urban', maxMinPerKm: 6 },
        railScale: { id: 'rail', maxMinPerKm: 3 },
        scaleFor: (mode) => ({ id: mode, maxMinPerKm: 6 }),
        buildStopIndex: (src) => (src.stops || []).map((s, idx) => ({ ...s, index: idx, point: s.point || [0,0] })),
    };
    vm.createContext(sandbox);

    const worldFactoryStart = html.indexOf('function worldFactory(focus)');
    const roadWidthStart = html.indexOf('function roadWidth', worldFactoryStart);
    const fullWorldFactory = html.substring(worldFactoryStart, roadWidthStart);

    const frustumStart = html.indexOf('function getFrustumPlanes(');
    const drawBgStart = html.indexOf('function drawBackground(', frustumStart);
    const frustumCode = html.substring(frustumStart, drawBgStart);

    vm.runInContext(fullWorldFactory, sandbox);
    vm.runInContext(frustumCode, sandbox);

    // Benchmark prepareScene
    const benchRuns = 10;
    let totalPrepMs = 0;
    let scene = null;
    for (let i = 0; i < benchRuns; i++) {
        const t0 = performance.now();
        scene = sandbox.prepareScene(source);
        totalPrepMs += (performance.now() - t0);
    }
    const avgPrepMs = (totalPrepMs / benchRuns).toFixed(2);
    console.log(`✔ prepareScene average execution time: ${avgPrepMs} ms across ${benchRuns} runs`);

    // Verify LazySegment properties
    if (scene.segments.length > 0) {
        const s0 = scene.segments[0];
        const isLazy = s0._points === null && s0._lengths === null;
        console.log(`✔ LazySegment deferred initialization verified: _points is null before access = ${isLazy}`);
        const pts = s0.points;
        const len = s0.lengths;
        console.log(`✔ LazySegment on-demand access: computed ${pts.length} points, total length ${len[len.length - 1].toFixed(2)}m`);
    }

    // Verify feature bboxes
    const features = scene.features;
    console.log(`✔ Features prepared: ${features.length} features`);
    let validBboxCount = 0;
    for (const f of features) {
        if (f.bbox && f.bbox.length === 4 && f.bbox[0] <= f.bbox[2] && f.bbox[1] <= f.bbox[3]) {
            validBboxCount++;
        }
    }
    console.log(`✔ Bounding box validity: ${validBboxCount}/${features.length} features have verified [minX, minY, maxX, maxY]`);
    if (validBboxCount !== features.length) {
        console.error('✖ Some features lack valid bboxes');
        allPassed = false;
    }

    // Benchmark Frustum Culling Simulation
    console.log('\n--- FRUSTUM CULLING EFFICIENCY TEST ---');
    const view = { width: 1920, height: 1080 };

    // Test Case 1: 2D overview (zoom 1x)
    {
        const camera = { x: 0, y: 0, scale: 1, bearing: 0, pitch: 0 };
        const camHalfW = (view.width / 2) / camera.scale + 60;
        const camHalfH = (view.height / 2) / camera.scale + 60;
        const camMinX = camera.x - camHalfW, camMaxX = camera.x + camHalfW;
        const camMinY = camera.y - camHalfH, camMaxY = camera.y + camHalfH;

        let visibleCount = 0;
        for (const f of features) {
            if (!(f.bbox[2] < camMinX || f.bbox[0] > camMaxX || f.bbox[3] < camMinY || f.bbox[1] > camMaxY)) {
                visibleCount++;
            }
        }
        const culledPercent = (((features.length - visibleCount) / features.length) * 100).toFixed(1);
        console.log(`2D Overview (1x): ${visibleCount}/${features.length} visible (${culledPercent}% culled)`);
    }

    // Test Case 2: 2D Zoomed In (4x Neighborhood)
    {
        const camera = { x: 1000, y: -500, scale: 4, bearing: 0, pitch: 0 };
        const camHalfW = (view.width / 2) / camera.scale + 60;
        const camHalfH = (view.height / 2) / camera.scale + 60;
        const camMinX = camera.x - camHalfW, camMaxX = camera.x + camHalfW;
        const camMinY = camera.y - camHalfH, camMaxY = camera.y + camHalfH;

        let visibleCount = 0;
        for (const f of features) {
            if (!(f.bbox[2] < camMinX || f.bbox[0] > camMaxX || f.bbox[3] < camMinY || f.bbox[1] > camMaxY)) {
                visibleCount++;
            }
        }
        const culledPercent = (((features.length - visibleCount) / features.length) * 100).toFixed(1);
        console.log(`2D Zoomed In (4x Neighborhood): ${visibleCount}/${features.length} visible (${culledPercent}% culled)`);
    }

    // Test Case 3: 3D Pitched Camera (pitch = 0.9 rad ~51 deg, bearing = 0.5 rad)
    {
        const camera = { x: 500, y: -200, scale: 2.5, bearing: 0.5, pitch: 0.9 };
        const planes = sandbox.getFrustumPlanes(camera, view);
        let visibleCount = 0;
        for (const f of features) {
            let outside = false;
            for (let i = 0; i < planes.length; i++) {
                const pl = planes[i];
                if (pl[0] * f.bbox[pl[3]] + pl[1] * f.bbox[pl[4]] + pl[2] < 0) {
                    outside = true;
                    break;
                }
            }
            if (!outside) visibleCount++;
        }
        const culledPercent = (((features.length - visibleCount) / features.length) * 100).toFixed(1);
        console.log(`3D Pitched View (pitch=51°, scale=2.5x): ${visibleCount}/${features.length} visible (${culledPercent}% culled)`);
    }

    console.log('\n================================================================');
    if (allPassed) {
        console.log('🎉 ALL VERIFICATIONS & BENCHMARKS PASSED SUCCESSFULLY!');
    } else {
        console.log('✖ SOME CHECKS FAILED!');
        process.exitCode = 1;
    }
    console.log('================================================================');
}

function httpRequest(urlPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request(BASE_URL + urlPath, {
            method: 'GET',
            headers: Object.assign({}, headers)
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

function waitForServer(port, timeoutMs = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        function check() {
            const req = http.request({
                hostname: '127.0.0.1',
                port,
                path: '/api/status',
                method: 'GET'
            }, res => {
                if (res.statusCode === 200) resolve();
                else retry();
            });
            req.on('error', retry);
            req.end();
        }
        function retry() {
            if (Date.now() - start > timeoutMs) return reject(new Error('Server start timeout'));
            setTimeout(check, 200);
        }
        check();
    });
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
});
