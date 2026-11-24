// labd: 실험 관리 서버
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"breaklab/internal/api"
	"breaklab/internal/lab"
	"breaklab/internal/proxyctl"
	"breaklab/internal/store"
)

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db := env("LAB_DB", "data/lab.db")
	if err := os.MkdirAll(filepath.Dir(db), 0o755); err != nil {
		log.Fatal(err)
	}
	st, err := store.Open(db)
	if err != nil {
		log.Fatalf("저장소를 열 수 없습니다: %v", err)
	}
	defer st.Close()

	px := proxyctl.New(env("TOXIPROXY_URL", "http://127.0.0.1:8474"), os.Getenv("TOXIPROXY_AUTH_TOKEN"), "lab_a_to_b",
		env("PROXY_LISTEN", "127.0.0.1:7721"), env("PROXY_UPSTREAM", "127.0.0.1:7720"))
	l := lab.New(lab.Config{
		AURL:    env("A_URL", "http://127.0.0.1:7710"),
		AHealth: env("A_HEALTH_URL", "http://127.0.0.1:7710/healthz"),
		BHealth: env("B_HEALTH_URL", "http://127.0.0.1:7720/healthz"),
	}, st, px)
	l.Recover()
	l.Loop(ctx)

	pub := &http.Server{Addr: env("LISTEN", "127.0.0.1:7700"), ReadHeaderTimeout: 5 * time.Second,
		Handler: api.Public(l, env("LAB_WEB_DIR", "../web/dist"),
			strings.Split(env("LAB_ALLOWED_HOSTS", "127.0.0.1:7700,localhost:7700,127.0.0.1:7780,localhost:7780"), ","))}
	tel := &http.Server{Addr: env("TELEMETRY_LISTEN", "127.0.0.1:7701"), ReadHeaderTimeout: 5 * time.Second, Handler: api.Telemetry(l)}
	for _, s := range []*http.Server{pub, tel} {
		go func() {
			if err := s.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				log.Printf("수신 실패 %s: %v", s.Addr, err)
				stop()
			}
		}()
	}
	log.Printf("관리 화면 http://%s, 관측 수신 %s", pub.Addr, tel.Addr)
	<-ctx.Done()
	log.Print("종료: 장애를 정리합니다")
	l.Shutdown()
	c, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tel.Shutdown(c)
	pub.Close()
}
