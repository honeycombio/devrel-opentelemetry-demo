// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

// sso-mocks stands in for third-party endpoints the auth service calls: the
// Keystone ID identity provider and Globex's employee-status endpoint. It runs
// as a sidecar in the auth pod, reached through hostAliases → 127.0.0.1.
// Deliberately uninstrumented: real third parties don't send us their spans.
package main

import (
	"encoding/json"
	"hash/fnv"
	"log"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	addr := getenv("SSO_MOCKS_ADDR", "127.0.0.1:443")
	certDir := getenv("SSO_MOCKS_CERT_DIR", "/certs")

	mux := http.NewServeMux()
	mux.HandleFunc("POST sso.keystone-id.example/api/v1/tenants/{tenant}/assertions/verify", verifyAssertion)
	mux.HandleFunc("GET sso-status.globex.example/v1/users/{id}", globexUserStatus)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	log.Printf("sso-mocks listening on %s", addr)
	log.Fatal(http.ListenAndServeTLS(addr, certDir+"/server.pem", certDir+"/server-key.pem", mux))
}

func verifyAssertion(w http.ResponseWriter, _ *http.Request) {
	jitter(20, 60)
	writeJSON(w, map[string]any{"valid": true})
}

// Globex marks about 4% of its users as no longer employed; always the same users.
func globexUserStatus(w http.ResponseWriter, r *http.Request) {
	jitter(30, 70)
	id := strings.TrimSpace(r.PathValue("id"))
	h := fnv.New32a()
	h.Write([]byte(id))
	status := "active"
	if h.Sum32()%25 == 0 {
		status = "terminated"
	}
	writeJSON(w, map[string]any{"id": id, "status": status})
}

func jitter(minMs, maxMs int) {
	time.Sleep(time.Duration(minMs+rand.IntN(maxMs-minMs+1)) * time.Millisecond)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
