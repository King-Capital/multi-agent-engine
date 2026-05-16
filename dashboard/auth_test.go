package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestIsPublicPath(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		method string
		path   string
		want   bool
	}{
		{name: "spa shell is public", method: http.MethodGet, path: "/", want: true},
		{name: "assets are public", method: http.MethodGet, path: "/assets/index.js", want: true},
		{name: "health is public", method: http.MethodGet, path: "/api/health", want: true},
		{name: "login is public", method: http.MethodPost, path: "/api/auth/login", want: true},
		{name: "users api is protected", method: http.MethodGet, path: "/api/users", want: false},
		{name: "session stream is protected", method: http.MethodGet, path: "/api/sessions/abc/stream", want: false},
		{name: "metrics are protected", method: http.MethodGet, path: "/metrics", want: false},
		{name: "htmx is protected", method: http.MethodGet, path: "/htmx/session/abc/graph", want: false},
		{name: "options preflight is public", method: http.MethodOptions, path: "/api/users", want: true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			req := httptest.NewRequest(tc.method, tc.path, nil)
			if got := isPublicPath(req); got != tc.want {
				t.Fatalf("isPublicPath(%s %s) = %v, want %v", tc.method, tc.path, got, tc.want)
			}
		})
	}
}
