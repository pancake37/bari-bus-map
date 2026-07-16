'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractZipJs } = require('../lib/zip');

const GTFS_ZIP = path.join(__dirname, '..', 'google_transit.zip');

describe('extractZipJs', () => {
    it('extracts google_transit.zip GTFS files', {
        skip: !fs.existsSync(GTFS_ZIP) && 'google_transit.zip not present'
    }, () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfs-zip-test-'));
        try {
            const result = extractZipJs(GTFS_ZIP, tmp);
            assert.equal(result.method, 'js');
            assert.ok(result.files.length >= 5);
            for (const name of ['routes.txt', 'stops.txt', 'trips.txt', 'stop_times.txt', 'shapes.txt']) {
                assert.ok(fs.existsSync(path.join(tmp, name)), 'missing ' + name);
            }
            const routes = fs.readFileSync(path.join(tmp, 'routes.txt'), 'utf8');
            assert.ok(routes.includes('route_id'));
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
