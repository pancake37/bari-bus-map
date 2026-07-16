'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const LOCAL_FILE_SIG = 0x04034b50;
const CENTRAL_DIR_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function findEocd(buf) {
    const start = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= start; i--) {
        if (buf.readUInt32LE(i) === EOCD_SIG) {
            return {
                cdCount: buf.readUInt16LE(i + 10),
                cdOffset: buf.readUInt32LE(i + 16)
            };
        }
    }
    return null;
}

/**
 * Pure-JS ZIP extract (store + deflate) with zip-slip protection.
 * @param {string} zipPath
 * @param {string} outDir
 * @returns {{ files: string[], method: string }}
 */
function extractZipJs(zipPath, outDir) {
    const buf = fs.readFileSync(zipPath);
    if (buf.length < 22) throw new Error('ZIP too small');

    const eocd = findEocd(buf);
    const entries = [];

    if (eocd) {
        let off = eocd.cdOffset;
        for (let i = 0; i < eocd.cdCount; i++) {
            if (off + 46 > buf.length || buf.readUInt32LE(off) !== CENTRAL_DIR_SIG) {
                throw new Error('Corrupt ZIP central directory at offset ' + off);
            }
            const method = buf.readUInt16LE(off + 10);
            const compSize = buf.readUInt32LE(off + 20);
            const uncompSize = buf.readUInt32LE(off + 24);
            const nameLen = buf.readUInt16LE(off + 28);
            const extraLen = buf.readUInt16LE(off + 30);
            const commentLen = buf.readUInt16LE(off + 32);
            const localOff = buf.readUInt32LE(off + 42);
            const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
            entries.push({ name, method, compSize, uncompSize, localOff });
            off += 46 + nameLen + extraLen + commentLen;
        }
    } else {
        let offset = 0;
        while (offset + 30 <= buf.length) {
            const sig = buf.readUInt32LE(offset);
            if (sig === CENTRAL_DIR_SIG || sig === EOCD_SIG) break;
            if (sig !== LOCAL_FILE_SIG) break;
            const flags = buf.readUInt16LE(offset + 6);
            const method = buf.readUInt16LE(offset + 8);
            const compSize = buf.readUInt32LE(offset + 18);
            const uncompSize = buf.readUInt32LE(offset + 22);
            const nameLen = buf.readUInt16LE(offset + 26);
            const extraLen = buf.readUInt16LE(offset + 28);
            const name = buf.toString('utf8', offset + 30, offset + 30 + nameLen);
            const dataStart = offset + 30 + nameLen + extraLen;
            if (flags & 0x8) {
                throw new Error('ZIP data descriptor without central directory is not supported');
            }
            entries.push({ name, method, compSize, uncompSize, localOff: offset, dataStart });
            offset = dataStart + compSize;
        }
    }

    fs.mkdirSync(outDir, { recursive: true });
    const files = [];
    const root = path.resolve(outDir);

    for (const ent of entries) {
        if (!ent.name || /\/$/.test(ent.name)) continue;

        const dest = path.resolve(outDir, ent.name);
        if (dest !== root && !dest.startsWith(root + path.sep)) {
            throw new Error('ZIP path escape blocked: ' + ent.name);
        }

        let dataStart = ent.dataStart;
        if (dataStart == null) {
            const lo = ent.localOff;
            if (buf.readUInt32LE(lo) !== LOCAL_FILE_SIG) {
                throw new Error('Bad local header for ' + ent.name);
            }
            const nameLen = buf.readUInt16LE(lo + 26);
            const extraLen = buf.readUInt16LE(lo + 28);
            dataStart = lo + 30 + nameLen + extraLen;
        }

        const compressed = buf.subarray(dataStart, dataStart + ent.compSize);
        let raw;
        if (ent.method === 0) {
            raw = Buffer.from(compressed);
        } else if (ent.method === 8) {
            raw = zlib.inflateRawSync(compressed);
        } else {
            throw new Error('Unsupported ZIP method ' + ent.method + ' for ' + ent.name);
        }

        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, raw);
        files.push(ent.name);
    }

    if (!files.length) throw new Error('ZIP contained no files');
    return { files, method: 'js' };
}

/**
 * Extract ZIP: pure JS first, then unzip CLI, then PowerShell on Windows.
 * @param {string} zipPath
 * @param {string} outDir
 * @returns {{ files?: string[], method: string }}
 */
function extractZip(zipPath, outDir) {
    fs.mkdirSync(outDir, { recursive: true });

    try {
        return extractZipJs(zipPath, outDir);
    } catch (jsErr) {
        console.warn('  JS unzip failed (' + jsErr.message + '), trying fallbacks...');
    }

    try {
        execSync('unzip -o -q "' + zipPath + '" -d "' + outDir + '"', {
            timeout: 60000,
            stdio: 'ignore'
        });
        return { method: 'unzip-cli' };
    } catch (_) { /* continue */ }

    if (process.platform === 'win32') {
        const psZip = zipPath.replace(/'/g, "''");
        const psOut = outDir.replace(/'/g, "''");
        execSync(
            'PowerShell -NoProfile -Command "Expand-Archive -Path \'' + psZip +
            '\' -DestinationPath \'' + psOut + '\' -Force"',
            { timeout: 60000, stdio: 'ignore' }
        );
        return { method: 'powershell' };
    }

    throw new Error('Unable to extract ZIP: JS unzip failed and no platform fallback available');
}

module.exports = { extractZip, extractZipJs };
