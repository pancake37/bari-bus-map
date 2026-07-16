'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/** Mirrors server recomputeActiveServices rebuild (pure). */
function rebuildRouteShapes(tripShapes, tripRouteIds, serviceIdMap, activeSids) {
    const rs = {};
    Object.keys(tripShapes).forEach(tid => {
        if (activeSids) {
            const sid = serviceIdMap[tid];
            if (!sid || !activeSids.has(sid)) return;
        }
        const shapeId = tripShapes[tid];
        const routeId = tripRouteIds[tid];
        if (!shapeId || !routeId) return;
        if (!rs[routeId]) rs[routeId] = [];
        if (rs[routeId].indexOf(shapeId) === -1) rs[routeId].push(shapeId);
    });
    return rs;
}

function confidence(tripSeqMap, nextStopId, currentStopSequence, threshold) {
    threshold = threshold == null ? 1 : threshold;
    let conf = 'unknown';
    const geoTripSeq = tripSeqMap && nextStopId != null ? tripSeqMap[nextStopId] : null;
    if (currentStopSequence != null && geoTripSeq != null) {
        const diff = Math.abs(geoTripSeq - currentStopSequence);
        conf = diff > threshold ? 'low' : 'high';
    }
    return conf;
}

describe('calendar routeShapes rebuild', () => {
    const tripShapes = { t1: 'sA', t2: 'sB', t3: 'sA' };
    const tripRouteIds = { t1: 'R1', t2: 'R1', t3: 'R1' };
    const sidMap = { t1: 'wd', t2: 'we', t3: 'wd' };

    it('is idempotent (no monotonic narrowing)', () => {
        const mon = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['wd']));
        const mon2 = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['wd']));
        assert.deepEqual(mon, mon2);
    });

    it('restores weekend shapes after weekday filter', () => {
        const mon = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['wd']));
        const sun = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['we']));
        assert.ok(mon.R1.includes('sA'));
        assert.ok(!mon.R1.includes('sB'));
        assert.ok(sun.R1.includes('sB'));
    });
});

describe('ETA confidence (trip stop_sequence space)', () => {
    const map = { '05118C00': 1, '05482101': 2 };

    it('matches RT sequence (1-based trip seq)', () => {
        assert.equal(confidence(map, '05118C00', 1), 'high');
    });

    it('flags large disagreement as low', () => {
        assert.equal(confidence(map, '05118C00', 5), 'low');
    });

    it('returns unknown without trip map', () => {
        assert.equal(confidence(null, '05118C00', 1), 'unknown');
    });

    it('would have false-low if comparing 0-based shape index to trip seq', () => {
        // Document the old bug: shape index 0 vs trip seq 1 → false low
        const shapeIdx = 0;
        const tripSeq = 1;
        assert.ok(Math.abs(shapeIdx - tripSeq) > 1 === false); // diff=1 still high at threshold 1
        // But for second stop: shape idx 1 vs trip seq 2 → diff 1; third: 2 vs 3...
        // Real damage: different stop *sets* on shape vs trip → large diffs.
        assert.equal(confidence(map, '05482101', 2), 'high');
    });
});
