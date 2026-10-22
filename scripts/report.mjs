#!/usr/bin/env node
// Summarises results/raw.jsonl: median of rounds, overhead = gateway latency minus direct latency.
import { readFileSync, writeFileSync } from 'node:fs';

const rows = readFileSync('results/raw.jsonl', 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const median = (a) => {
    const s = a.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const groups = new Map();
for (const r of rows) {
    if (!r.label) continue;
    const k = `${r.label}|${r.scenario}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
}
const summary = [];
for (const [k, rs] of groups) {
    const [label, scenario] = k.split('|');
    const pick = (f) => median(rs.map((r) => r[f]));
    summary.push({
        label, scenario, rounds: rs.length,
        success_pct: median(rs.map((r) => (100 * r.ok) / r.sent)),
        achieved_rps: pick('achieved_rps'),
        p50_ms: pick('p50_ms'), p99_ms: pick('p99_ms'),
        ttfb_p50_ms: pick('ttfb_p50_ms'), ttfb_p99_ms: pick('ttfb_p99_ms'),
        peak_cpu_pct: pick('peak_cpu_pct'), peak_mem_mib: pick('peak_mem_mib'),
    });
}
const direct = Object.fromEntries(summary.filter((s) => s.label === 'direct').map((s) => [s.scenario, s]));
for (const s of summary) {
    const d = direct[s.scenario];
    const stream = s.scenario.startsWith('stream');
    s.overhead_p50_ms = d ? (stream ? s.ttfb_p50_ms - d.ttfb_p50_ms : s.p50_ms - d.p50_ms) : NaN;
    s.overhead_p99_ms = d ? (stream ? s.ttfb_p99_ms - d.ttfb_p99_ms : s.p99_ms - d.p99_ms) : NaN;
}
writeFileSync('results/summary.json', JSON.stringify(summary, null, 2));

const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
console.log('| target | scenario | success % | rps | p50 ms | p99 ms | +p50 ms | +p99 ms | cpu % | mem MiB |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const s of summary) {
    const stream = s.scenario.startsWith('stream');
    console.log(`| ${s.label} | ${s.scenario} | ${f(s.success_pct, 1)} | ${f(s.achieved_rps, 0)} | ${f(stream ? s.ttfb_p50_ms : s.p50_ms)} | ${f(stream ? s.ttfb_p99_ms : s.p99_ms)} | ${f(s.overhead_p50_ms)} | ${f(s.overhead_p99_ms)} | ${f(s.peak_cpu_pct, 0)} | ${f(s.peak_mem_mib, 0)} |`);
}
console.log('\nStreaming rows show time to first chunk. +p50/+p99 = minus the direct (no gateway) run.');
