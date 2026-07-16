'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseCSVLine } = require('../lib/csv');

describe('parseCSVLine', () => {
    it('splits plain fields', () => {
        assert.deepEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
    });

    it('keeps commas inside quotes', () => {
        assert.deepEqual(parseCSVLine('a,"b,c",d'), ['a', 'b,c', 'd']);
    });

    it('unescapes doubled quotes', () => {
        assert.deepEqual(parseCSVLine('"x""y",z'), ['x"y', 'z']);
    });

    it('handles empty fields', () => {
        assert.deepEqual(parseCSVLine('a,,c'), ['a', '', 'c']);
    });

    it('handles trailing comma', () => {
        assert.deepEqual(parseCSVLine('a,b,'), ['a', 'b', '']);
    });
});
