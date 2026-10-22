// Open-loop load generator: fires requests on a fixed schedule and measures latency
// from the scheduled send time, so a slow gateway cannot hide behind fewer requests.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

type headers []string

func (h *headers) String() string     { return strings.Join(*h, ",") }
func (h *headers) Set(v string) error { *h = append(*h, v); return nil }

type sample struct {
	total time.Duration
	ttfb  time.Duration
	ok    bool
	code  int
}

const prompt = "You are a helpful assistant. Summarise the following support ticket in three bullet points and suggest a priority. "

func main() {
	url := flag.String("url", "http://127.0.0.1:9000/v1/chat/completions", "target URL")
	label := flag.String("label", "direct", "label written to the result")
	rate := flag.Int("rate", 100, "requests per second")
	duration := flag.Duration("duration", 30*time.Second, "measured phase")
	warmup := flag.Duration("warmup", 5*time.Second, "unmeasured warm-up at the same rate")
	stream := flag.Bool("stream", false, "request SSE streaming")
	model := flag.String("model", "gpt-mock", "model field")
	timeout := flag.Duration("timeout", 10*time.Second, "per-request timeout")
	var hdrs headers
	flag.Var(&hdrs, "H", "extra header 'Key: Value' (repeatable)")
	flag.Parse()

	body, _ := json.Marshal(map[string]any{
		"model":  *model,
		"stream": *stream,
		"messages": []any{
			map[string]string{"role": "system", "content": "You are a concise assistant."},
			map[string]string{"role": "user", "content": strings.Repeat(prompt, 8)},
		},
	})

	tr := &http.Transport{
		DialContext:         (&net.Dialer{Timeout: 3 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:        4096,
		MaxIdleConnsPerHost: 4096,
		IdleConnTimeout:     90 * time.Second,
		DisableCompression:  true,
	}
	client := &http.Client{Transport: tr, Timeout: *timeout}

	do := func(scheduled time.Time) sample {
		ctx, cancel := context.WithTimeout(context.Background(), *timeout)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost, *url, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer sk-bench")
		for _, h := range hdrs {
			if k, v, ok := strings.Cut(h, ":"); ok {
				req.Header.Set(strings.TrimSpace(k), strings.TrimSpace(v))
			}
		}
		resp, err := client.Do(req)
		if err != nil {
			return sample{total: time.Since(scheduled)}
		}
		defer resp.Body.Close()
		s := sample{code: resp.StatusCode}
		if !*stream {
			b, err := io.ReadAll(resp.Body)
			s.total = time.Since(scheduled)
			s.ttfb = s.total
			s.ok = err == nil && resp.StatusCode == 200 && bytes.Contains(b, []byte(`"choices"`))
			return s
		}
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		chunks, done := 0, false
		for sc.Scan() {
			line := sc.Text()
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			if chunks == 0 {
				s.ttfb = time.Since(scheduled)
			}
			if strings.TrimSpace(strings.TrimPrefix(line, "data:")) == "[DONE]" {
				done = true
				break
			}
			chunks++
		}
		s.total = time.Since(scheduled)
		s.ok = resp.StatusCode == 200 && done && chunks > 1
		return s
	}

	run := func(d time.Duration, keep bool) []sample {
		interval := time.Second / time.Duration(*rate)
		n := int(d / interval)
		out := make([]sample, n)
		var wg sync.WaitGroup
		start := time.Now()
		for i := 0; i < n; i++ {
			at := start.Add(time.Duration(i) * interval)
			if w := time.Until(at); w > 0 {
				time.Sleep(w)
			}
			wg.Add(1)
			go func(i int, at time.Time) {
				defer wg.Done()
				out[i] = do(at)
			}(i, at)
		}
		wg.Wait()
		if !keep {
			return nil
		}
		return out
	}

	if *warmup > 0 {
		run(*warmup, false)
	}
	t0 := time.Now()
	res := run(*duration, true)
	wall := time.Since(t0)

	var lat, ttfb []float64
	errors := 0
	codes := map[int]int{}
	for _, s := range res {
		codes[s.code]++
		if !s.ok {
			errors++
			continue
		}
		lat = append(lat, float64(s.total.Microseconds())/1000)
		ttfb = append(ttfb, float64(s.ttfb.Microseconds())/1000)
	}
	sort.Float64s(lat)
	sort.Float64s(ttfb)
	pct := func(a []float64, p float64) float64 {
		if len(a) == 0 {
			return 0
		}
		i := int(p * float64(len(a)-1))
		return a[i]
	}
	out := map[string]any{
		"label": *label, "rate": *rate, "stream": *stream,
		"sent": len(res), "ok": len(lat), "errors": errors, "codes": codes,
		"achieved_rps": float64(len(lat)) / wall.Seconds(),
		"p50_ms":       pct(lat, 0.50), "p90_ms": pct(lat, 0.90), "p99_ms": pct(lat, 0.99), "max_ms": pct(lat, 1),
		"ttfb_p50_ms": pct(ttfb, 0.50), "ttfb_p99_ms": pct(ttfb, 0.99),
	}
	json.NewEncoder(os.Stdout).Encode(out)
	if len(lat) == 0 {
		fmt.Fprintln(os.Stderr, "no successful requests")
		os.Exit(1)
	}
}
