# AI gateway benchmark

[![ci](https://github.com/LF3551/ai-gateway-benchmark/actions/workflows/ci.yml/badge.svg)](https://github.com/LF3551/ai-gateway-benchmark/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

How much latency does an AI gateway (LLM gateway) add in front of a model, and what does it cost in CPU and memory?

This repo puts four popular self-hosted gateways and a plain reverse proxy in front of the same mock OpenAI-compatible model and measures the extra time each one adds. The mock answers instantly, so every millisecond above the direct run is the gateway's own work.

Write-up: [AI Gateway vs LLM Gateway, explained (with a latency benchmark)](https://www.alekseialeinikov.com/en/blog/topics/ai/ai-gateway-llm-gateway-explained-latency-benchmark)

## What is measured

| Target | Image | Role |
|---|---|---|
| `direct` | none | the load generator talks to the mock directly (baseline) |
| `nginx` | `nginx:1.29-alpine` | plain reverse proxy: the floor for "one extra hop" |
| `kong` | `kong:3.9` | Kong with the `ai-proxy` plugin, DB-less |
| `portkey` | `portkeyai/gateway:1.15.2` | Portkey open-source gateway |
| `litellm` | `ghcr.io/berriai/litellm:v1.106.2` | LiteLLM proxy, 2 workers |

All images are pinned by digest in [`compose.yaml`](compose.yaml).

Scenarios (see [`config.json`](config.json)):

- `chat-100rps` … `chat-2000rps`: non-streaming chat completions at a fixed arrival rate.
- `stream-100rps`, `stream-500rps`: streaming chat completions (40 SSE chunks); latency is time to first chunk.

## Fairness rules

- Every gateway gets the same budget: **2 CPUs and 2 GB RAM**. Only one gateway runs at a time.
- The load generator (4 CPUs) and the mock (2 CPUs) run in their own containers on the same Docker network.
- The load is **open-loop**: requests are fired on a fixed schedule and latency is measured from the scheduled time, so a slow gateway cannot hide behind a slower request rate (no coordinated omission).
- A request only counts as a success if the answer is valid: HTTP 200 and a `choices` body, or for streams HTTP 200, more than one chunk and a final `[DONE]`.
- Each scenario runs 3 rounds of 20 s after a 5 s warm-up; the report shows the median round.
- Default settings everywhere. No caching, no logging to a database, no guardrails. Access logs are off for nginx and Kong.
- LiteLLM refuses to start without a master key, so it checks one on every request; the other gateways run without auth.

## Run it

Requirements: Docker with Compose v2 and Node.js 18+. Go is not needed locally: the mock and the load generator are built inside Docker. Give Docker at least 8 CPUs so the gateway, the mock and the load generator never compete for the same cores. A full run takes about an hour.

```sh
git clone https://github.com/LF3551/ai-gateway-benchmark
cd ai-gateway-benchmark
docker compose build
node scripts/smoke.mjs            # optional: needs the gateways up, see below
node scripts/bench.mjs            # full run, writes results/raw.jsonl
node scripts/report.mjs           # medians, overhead vs direct, results/summary.json
```

Shorter run or a subset:

```sh
node scripts/bench.mjs --rounds 1 --duration 10 --only direct,kong
```

To smoke-test by hand, start everything first:

```sh
docker compose --profile nginx --profile kong --profile portkey --profile litellm up -d
node scripts/smoke.mjs
docker compose --profile nginx --profile kong --profile portkey --profile litellm down
```

## Results

One run, 2 CPUs and 2 GB per gateway, median of 3 rounds. Added latency is measured at 100 rps against the direct call; "keeps up to" is the highest tested rate with every answer valid and p99 under 100 ms.

| Gateway | Added to chat reply, p50 | Added to first streamed token, p50 | Keeps up to (chat / stream) | Peak CPU / memory |
|---|---|---|---|---|
| nginx 1.29 (floor) | +0.31 ms | +0.48 ms | 2,000+ / 500+ rps | 18% / 10 MiB |
| Kong 3.9, `ai-proxy` | +0.85 ms | +1.07 ms | 2,000+ / 500+ rps | 32% / 300 MiB |
| Portkey 1.15 | +1.73 ms | +27.9 ms | 2,000+ / 500+ rps | 118% / 80 MiB |
| LiteLLM 1.106, 2 workers | +3.82 ms | +10.1 ms | ~400 / ~100 rps | 200% / 2 GiB |

- Portkey's extra time on streams is a constant before the first chunk, not buffering: with the mock slowed to 20 ms and 100 ms between chunks (`-chunk-delay`), the whole stream took as long as a direct call.
- LiteLLM's limits come from a separate step test at 150 to 400 rps. Past them, latency rises to seconds and requests fail (60% valid at 1,000 chat rps). It was CPU-bound, not out of memory: no OOM kill, and 1.5 GiB is its idle footprint with two workers.

The write-up linked above has the chart and the discussion. Your own run prints the same table from `node scripts/report.mjs` and writes `results/summary.json`.

## Reading the results

- `+p50` / `+p99` is the gateway's latency minus the direct run in the same scenario: the time the gateway itself adds.
- `success %` below 100 means the gateway dropped, timed out or broke responses at that rate. Read latency only next to the success rate.
- `cpu %` is the peak from `docker stats`; 200 % means both CPUs of the budget were busy.
- Absolute numbers depend on the machine. Compare gateways with each other within one run, not with numbers from another machine.

## About the LiteLLM key

The `LITELLM_MASTER_KEY` in [`compose.yaml`](compose.yaml) and the matching header in [`config.json`](config.json) are a throwaway value. They only exist because LiteLLM refuses to start without a strong master key; the container is reachable only on the benchmark's private Docker network and holds no provider keys. Change both together if you like.

No real provider is ever called: every gateway points at the local mock, and no API key of OpenAI or anyone else is needed.

## CI

- [`ci.yml`](.github/workflows/ci.yml) runs on every push: `go vet`, `gofmt`, a Compose config check, then starts every gateway and sends plain and streaming requests through each one.
- [`benchmark.yml`](.github/workflows/benchmark.yml) is a manual full run that uploads the results as an artifact. GitHub runners have 4 shared vCPUs, so use it to check the harness, not to compare gateways.

## Layout

```
cmd/mock      mock OpenAI-compatible upstream (Go)
cmd/load      open-loop load generator (Go)
gateways/     one config per gateway
config.json   scenarios, targets, pinned image versions
scripts/      bench.mjs (runner), report.mjs (summary), smoke.mjs (quick check)
```

## A note on LiteLLM 1.107.0

LiteLLM 1.107.0 (PyPI and Docker tags `v1.107.0`, `latest`, `main-latest`, `main-stable`, 21 Oct 2026) shipped a credential stealer. This benchmark pins `v1.106.2` by digest. If you installed 1.107.0 anywhere, follow the [official incident report](https://litellm.ai/blog?post=security-incident-oct-21-2026) and rotate every key that machine could read.

## License

[MIT](LICENSE)
