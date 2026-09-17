package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/url"
	"syscall"
	"testing"
)

func TestNetworkErrorCategoriesDoNotExposeTransportDetails(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{context.DeadlineExceeded, "timeout"}, {context.Canceled, "canceled"},
		{io.EOF, "eof"}, {io.ErrUnexpectedEOF, "unexpected_eof"},
		{syscall.ECONNRESET, "connection_reset"}, {syscall.ECONNREFUSED, "connection_refused"},
		{syscall.EPIPE, "broken_pipe"}, {&net.DNSError{Name: "private-host", Err: "secret"}, "dns"},
		{errors.New("secret connection failure"), "other"},
	} {
		wrapped := &url.Error{Op: "Post", URL: "https://secret@private-host", Err: tc.err}
		if got := classifyNetworkError(wrapped); got != tc.want {
			t.Fatalf("got=%s want=%s", got, tc.want)
		}
	}
}
func TestErrorSnapshotDoesNotMutateRecorder(t *testing.T) {
	recorder := &errorClassRecorder{}
	recorder.add("eof")
	recorder.add("eof")
	snapshot := recorder.snapshot()
	snapshot["eof"] = 0
	if recorder.snapshot()["eof"] != 2 {
		t.Fatal("snapshot mutates recorder")
	}
}
