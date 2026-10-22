#!/usr/bin/env node
// Runs every gateway in turn against the same mock upstream and writes results/raw.jsonl.
// Usage: node scripts/bench.mjs [--rounds 3] [--duration 20] [--only litellm,kong]
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
};
const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url)));
const rounds = Number(opt('rounds', config.rounds));
const duration = Number(opt('duration', config.durationSeconds));
const only = opt('only', '');
const targets = config.targets.filter((t) => !only || only.split(',').includes(t.name));

mkdirSync('results', { recursive: true });
const raw = 'results/raw.jsonl';
writeFileSync(raw, '');

const compose = (...a) => execFileSync('docker', ['compose', ...a], { encoding: 'utf8' }).trim();

function load(t, rate, stream, seconds, warmup) {
    const a = ['run', '--rm', 'load', '-url', t.url, '-label', t.name, '-rate', String(rate),
        '-duration', `${seconds}s`, '-warmup', `${warmup}s`];
    if (stream) a.push('-stream');
    for (const h of t.headers ?? []) a.push('-H', h);
    try {
        const out = compose(...a);
        return JSON.parse(out.split('\n').filter((l) => l.startsWith('{')).pop());
    } catch (e) {
        const line = (e.stdout ?? '').split('\n').find((l) => l.startsWith('{'));
        return line ? JSON.parse(line) : null;
    }
}

async function waitReady(t) {
    for (let i = 0; i < 60; i++) {
        const r = load(t, 2, false, 1, 0);
        if (r && r.ok > 0) return true;
        await sleep(2000);
    }
    return false;
}

// Samples container CPU and memory while a scenario runs; keeps the peaks.
function watch(service) {
    if (!service) return { stop: async () => ({}) };
    const id = compose('ps', '-q', service);
    let peakCpu = 0, peakMem = 0, running = true;
    const toMiB = (s) => {
        const m = /([\d.]+)\s*([KMG]i?B)/.exec(s);
        if (!m) return 0;
        const f = { KiB: 1 / 1024, KB: 1 / 1024, MiB: 1, MB: 1, GiB: 1024, GB: 1024 }[m[2]] ?? 1;
        return Number(m[1]) * f;
    };
    const loop = (async () => {
        while (running) {
            await new Promise((res) => {
                const p = spawn('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}', id]);
                let s = '';
                p.stdout.on('data', (d) => (s += d));
                p.on('close', () => {
                    const [cpu, mem] = s.trim().split('|');
                    peakCpu = Math.max(peakCpu, parseFloat(cpu) || 0);
                    peakMem = Math.max(peakMem, toMiB(mem ?? ''));
                    res();
                });
            });
        }
    })();
    return {
        stop: async () => {
            running = false;
            await loop;
            return { peak_cpu_pct: peakCpu, peak_mem_mib: Math.round(peakMem) };
        },
    };
}

compose('up', '-d', 'mock');
for (const t of targets) {
    if (t.service) compose('--profile', t.service, 'up', '-d', t.service);
    process.stdout.write(`\n== ${t.name}: waiting for readiness... `);
    if (!(await waitReady(t))) {
        console.log('not ready, skipped');
        if (t.service) compose('--profile', t.service, 'rm', '-sf', t.service);
        continue;
    }
    console.log('ready');
    for (let round = 1; round <= rounds; round++) {
        for (const s of config.scenarios) {
            const w = watch(t.service);
            const r = load(t, s.rate, s.stream, duration, config.warmupSeconds);
            const usage = await w.stop();
            const row = { round, scenario: s.name, ...r, ...usage };
            appendFileSync(raw, JSON.stringify(row) + '\n');
            console.log(`  r${round} ${s.name.padEnd(14)} ok=${r?.ok ?? 0}/${r?.sent ?? 0} p50=${r?.p50_ms?.toFixed(2)}ms p99=${r?.p99_ms?.toFixed(2)}ms cpu=${usage.peak_cpu_pct ?? '-'}% mem=${usage.peak_mem_mib ?? '-'}MiB`);
            await sleep(3000);
        }
    }
    if (t.service) compose('--profile', t.service, 'rm', '-sf', t.service);
}
compose('down');
console.log(`\nRaw results: ${raw}. Summarise with: node scripts/report.mjs`);
