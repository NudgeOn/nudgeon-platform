package main

import (
	"context"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// Inject this test into cmd/loadgen with a Go overlay. It exercises the actual
// postTrack implementation without changing the application or sending events.
func TestLocalOpsTransportReusesHTTPConnection(t *testing.T) {
	var connections atomic.Int64
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"accepted":1}`))
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	server.Start()
	defer server.Close()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: time.Second}
	for i := 0; i < 10; i++ {
		result := postTrack(context.Background(), client, server.URL, "pk_local_probe", "connection-probe", loadJob{sequence: int64(i), scheduledAt: time.Now()}, rand.New(rand.NewPCG(1, 7)))
		if result.err != nil || result.statusCode != http.StatusAccepted {
			t.Fatalf("request %d failed: %+v", i, result)
		}
	}
	t.Logf("10 sequential requests opened %d TCP connections", connections.Load())
	if connections.Load() > 1 {
		t.Fatalf("HTTP connection was not reused; read the response body before closing it")
	}
}
