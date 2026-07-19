'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dateToGtfsStr, getActiveServiceIds, rebuildRouteShapes, rebuildStopInfo } = require('../lib/calendar');

describe('service calendar', () => {
    it('uses local date rather than UTC date', () => {
        const date = new Date('2026-07-19T00:30:00+02:00');
        assert.equal(dateToGtfsStr(date, 'Europe/Rome'), '20260719');
    });

    it('supports feeds that define service only through calendar_dates', () => {
        const active = getActiveServiceIds({}, {
            'FER|20260719': '2',
            'FEST|20260719': '1',
            'GIOR|20260719': '1'
        }, new Date('2026-07-19T12:00:00+02:00'), 'Europe/Rome');
        assert.deepEqual([...active].sort(), ['FEST', 'GIOR']);
    });
});

describe('daily GTFS views', () => {
    const tripShapes = { t1: 'sA', t2: 'sB', t3: 'sA' };
    const tripRouteIds = { t1: 'R1', t2: 'R1', t3: 'R1' };
    const sidMap = { t1: 'wd', t2: 'we', t3: 'wd' };

    it('rebuilds route shapes without monotonic narrowing', () => {
        const mon = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['wd']));
        const sun = rebuildRouteShapes(tripShapes, tripRouteIds, sidMap, new Set(['we']));
        assert.deepEqual(mon, { R1: ['sA'] });
        assert.deepEqual(sun, { R1: ['sB'] });
    });

    it('rebuilds stop information when the active service changes', () => {
        const stopTimes = {
            stop1: [
                { trip_id: 't1', route_id: 'R1', arrival: '08:00:00', headsign: 'Weekday' },
                { trip_id: 't2', route_id: 'R1', arrival: '09:00:00', headsign: 'Weekend' }
            ]
        };
        assert.equal(rebuildStopInfo(stopTimes, sidMap, new Set(['wd'])).stop1[0].headsign, 'Weekday');
        assert.equal(rebuildStopInfo(stopTimes, sidMap, new Set(['we'])).stop1[0].headsign, 'Weekend');
    });
});

describe('ETA confidence (trip stop_sequence space)', () => {
    const map = { '05118C00': 1, '05482101': 2 };
    function confidence(tripSeqMap, nextStopId, currentStopSequence, threshold = 1) {
        const geoTripSeq = tripSeqMap && nextStopId != null ? tripSeqMap[nextStopId] : null;
        if (currentStopSequence == null || geoTripSeq == null) return 'unknown';
        return Math.abs(geoTripSeq - currentStopSequence) > threshold ? 'low' : 'high';
    }

    it('reports high, low and unknown confidence correctly', () => {
        assert.equal(confidence(map, '05118C00', 1), 'high');
        assert.equal(confidence(map, '05118C00', 5), 'low');
        assert.equal(confidence(null, '05118C00', 1), 'unknown');
    });
});
