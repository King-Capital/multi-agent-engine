package main

import (
	"encoding/json"
	"net/http"
	"runtime"
)

// Injected at build time via -ldflags
// e.g. go build -ldflags "-X main.Version=1.0.0 -X main.BuildTime=2026-05-07T00:00:00Z"
var (
	Version   = "dev"
	BuildTime = "unknown"
)

type versionResponse struct {
	Version   string `json:"version"`
	BuildTime string `json:"build_time"`
	GoVersion string `json:"go_version"`
}

func handleAPIVersion(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(versionResponse{
		Version:   Version,
		BuildTime: BuildTime,
		GoVersion: runtime.Version(),
	})
}
