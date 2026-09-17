package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"net"
	"sync"
	"syscall"
)

// Bounded categories only. Never persist err.Error(): transport errors may
// contain a URL, proxy credentials, certificate details or other private data.
func classifyNetworkError(err error) string {
	if isTimeout(err) {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "canceled"
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return "unexpected_eof"
	}
	if errors.Is(err, io.EOF) {
		return "eof"
	}
	if errors.Is(err, syscall.ECONNRESET) {
		return "connection_reset"
	}
	if errors.Is(err, syscall.ECONNREFUSED) {
		return "connection_refused"
	}
	if errors.Is(err, syscall.EPIPE) {
		return "broken_pipe"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var cert *tls.CertificateVerificationError
	var authority x509.UnknownAuthorityError
	var hostname x509.HostnameError
	if errors.As(err, &cert) || errors.As(err, &authority) || errors.As(err, &hostname) {
		return "tls_certificate"
	}
	return "other"
}

type errorClassRecorder struct {
	mu     sync.Mutex
	counts map[string]int64
}

func (r *errorClassRecorder) add(class string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.counts == nil {
		r.counts = make(map[string]int64)
	}
	r.counts[class]++
}
func (r *errorClassRecorder) snapshot() map[string]int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make(map[string]int64, len(r.counts))
	for class, count := range r.counts {
		result[class] = count
	}
	return result
}
