#!/usr/bin/env node
// Sends a few plain and streaming requests to every target that is already up.
// Retries each target for up to --wait seconds; exits 1 if any target never answers correctly.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const i = args.indexOf('--wait');
const waitSeconds = i >= 0 ? Number(args[i + 1]) : 0;
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));

function probe(t, stream) {
    const a = ['compose', 'run', '--rm', '-T', 'load', '-url', t.url, '-label', t.name,
        '-rate', '5', '-duration', '2s', '-warmup', '0s'];
    if (stream) a.push('-stream');
    for (const h of t.headers ?? []) a.push('-H', h);
    let out = '';
    try {
        out = execFileSync('docker', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        out = e.stdout ?? '';
    }
    const line = out.split('\n').find((l) => l.startsWith('{'));
    return line ? JSON.parse(line) : null;
}

let failed = 0;
for (const t of config.targets) {
    for (const stream of [false, true]) {
        const deadline = Date.now() + waitSeconds * 1000;
        let r = probe(t, stream);
        while ((!r || r.ok !== r.sent) && Date.now() < deadline) {
            await sleep(3000);
            r = probe(t, stream);
        }
        const ok = r && r.sent > 0 && r.ok === r.sent;
        if (!ok) failed++;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${t.name.padEnd(8)} ${stream ? 'stream' : 'plain '} ${r ? `ok=${r.ok}/${r.sent} codes=${JSON.stringify(r.codes)} p50=${r.p50_ms?.toFixed(2)}ms` : 'no result'}`);
    }
}
process.exitCode = failed ? 1 : 0;
