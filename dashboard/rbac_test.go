package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSessionMutationHandlersRequireAdmin(t *testing.T) {
	cases := []struct {
		name    string
		handler http.HandlerFunc
		method  string
		path    string
		body    string
	}{
		{name: "delete session", handler: handleDeleteSession, method: http.MethodDelete, path: "/api/sessions/s1"},
		{name: "close stale", handler: handleCloseStale, method: http.MethodPost, path: "/api/sessions/close-stale"},
		{name: "clear stale", handler: handleClearStale, method: http.MethodDelete, path: "/api/sessions/stale"},
		{name: "clear all", handler: handleClearAll, method: http.MethodDelete, path: "/api/sessions/all"},
		{name: "set session status", handler: handleSetSessionStatus, method: http.MethodPatch, path: "/api/sessions/s1/status", body: `{"status":"completed"}`},
		{name: "user message injection", handler: handleUserMessage, method: http.MethodPost, path: "/api/sessions/s1/message", body: "content=stop"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			rr := httptest.NewRecorder()
			tc.handler(rr, req)
			if rr.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
			}
		})
	}
}
