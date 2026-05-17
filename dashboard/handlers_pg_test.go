package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
)

func TestHandleAPICreateSessionRejectsInvalidID(t *testing.T) {
	dbEnabled = true
	req := httptest.NewRequest(http.MethodPost, "/api/pg/sessions", strings.NewReader(`{"id":"not-a-uuid","name":"bad"}`))
	rec := httptest.NewRecorder()

	handleAPICreateSession(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}

func TestHandleAPIGetSessionEventsRejectsInvalidID(t *testing.T) {
	dbEnabled = true
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("id", "not-a-uuid")
	req := httptest.NewRequest(http.MethodGet, "/api/pg/sessions/not-a-uuid/events", nil)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()

	handleAPIGetSessionEvents(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusBadRequest, rec.Body.String())
	}
}
