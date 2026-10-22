// Mock OpenAI-compatible upstream: answers instantly so only gateway overhead is measured.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type chatRequest struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

var content = strings.Repeat("The gateway adds a hop between your app and the model. ", 24)

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen address")
	chunks := flag.Int("chunks", 40, "SSE chunks per streamed answer")
	chunkDelay := flag.Duration("chunk-delay", 0, "pause between SSE chunks")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"object":"list","data":[{"id":"gpt-mock","object":"model","owned_by":"bench"}]}`)
	})
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, `{"error":{"message":"bad json"}}`, http.StatusBadRequest)
			return
		}
		if req.Model == "" {
			req.Model = "gpt-mock"
		}
		now := time.Now().Unix()
		if !req.Stream {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]any{
				"id": "chatcmpl-bench", "object": "chat.completion", "created": now, "model": req.Model,
				"choices": []any{map[string]any{
					"index": 0, "finish_reason": "stop",
					"message": map[string]any{"role": "assistant", "content": content},
				}},
				"usage": map[string]any{"prompt_tokens": 220, "completion_tokens": 300, "total_tokens": 520},
			})
			return
		}
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "no flush", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		words := strings.Fields(content)
		for i := 0; i < *chunks; i++ {
			delta := map[string]any{"content": words[i%len(words)] + " "}
			if i == 0 {
				delta["role"] = "assistant"
			}
			b, _ := json.Marshal(map[string]any{
				"id": "chatcmpl-bench", "object": "chat.completion.chunk", "created": now, "model": req.Model,
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": nil}},
			})
			fmt.Fprintf(w, "data: %s\n\n", b)
			fl.Flush()
			if *chunkDelay > 0 {
				time.Sleep(*chunkDelay)
			}
		}
		b, _ := json.Marshal(map[string]any{
			"id": "chatcmpl-bench", "object": "chat.completion.chunk", "created": now, "model": req.Model,
			"choices": []any{map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": 220, "completion_tokens": *chunks, "total_tokens": 220 + *chunks},
		})
		fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", b)
		fl.Flush()
	})

	srv := &http.Server{Addr: *addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	log.Printf("mock upstream on http://%s", *addr)
	log.Fatal(srv.ListenAndServe())
}
