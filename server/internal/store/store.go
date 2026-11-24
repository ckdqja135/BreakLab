// Package store는 실행 이력을 SQLite에 저장한다.
package store

import (
	"database/sql"
	"encoding/json"

	"breaklab/internal/model"
	"breaklab/internal/wire"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, started_us INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS faults(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, requested_us INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traces(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, started_us INTEGER NOT NULL, doc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at_us INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS traces_run ON traces(run_id, started_us);
CREATE INDEX IF NOT EXISTS faults_run ON faults(run_id);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
`

const keepRuns = 200

type Store struct{ db *sql.DB }

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(2000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) put(q string, v any, args ...any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	_, err = s.db.Exec(q, append(args, string(b))...)
	return err
}

func (s *Store) SaveRun(r model.Run) error {
	return s.put(`INSERT INTO runs(id,started_us,doc) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`, r, r.ID, r.StartedUs)
}

func (s *Store) SaveFault(f model.Fault) error {
	return s.put(`INSERT INTO faults(id,run_id,requested_us,doc) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`, f, f.ID, f.RunID, f.RequestedUs)
}

func (s *Store) SaveTrace(t model.Trace) error {
	return s.put(`INSERT INTO traces(id,run_id,started_us,doc) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET doc=excluded.doc`, t, t.TraceID, t.RunID, t.StartUs)
}

func (s *Store) AddEvent(e model.Event) error {
	_, err := s.db.Exec(`INSERT INTO events(run_id,at_us,type,detail) VALUES(?,?,?,?)`, e.RunID, e.AtUs, e.Type, e.Detail)
	return err
}

func query[T any](s *Store, q string, args ...any) ([]T, error) {
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var doc string
		var v T
		if err := rows.Scan(&doc); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(doc), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *Store) Runs() ([]model.Run, error) {
	return query[model.Run](s, `SELECT doc FROM runs ORDER BY started_us DESC LIMIT ?`, keepRuns)
}
func (s *Store) Run(id string) ([]model.Run, error) {
	return query[model.Run](s, `SELECT doc FROM runs WHERE id=?`, id)
}
func (s *Store) Faults(runID string) ([]model.Fault, error) {
	return query[model.Fault](s, `SELECT doc FROM faults WHERE run_id=? ORDER BY requested_us`, runID)
}
func (s *Store) AllFaults() ([]model.Fault, error) {
	return query[model.Fault](s, `SELECT doc FROM faults ORDER BY requested_us`)
}
func (s *Store) Traces(runID string) ([]model.Trace, error) {
	return query[model.Trace](s, `SELECT doc FROM traces WHERE run_id=? ORDER BY started_us`, runID)
}

func (s *Store) Events(runID string) ([]model.Event, error) {
	rows, err := s.db.Query(`SELECT id,run_id,at_us,type,detail FROM events WHERE run_id=? ORDER BY id`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Event{}
	for rows.Next() {
		var e model.Event
		if err := rows.Scan(&e.ID, &e.RunID, &e.AtUs, &e.Type, &e.Detail); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// Prune은 오래된 실행을 지운다.
func (s *Store) Prune() error {
	for _, q := range []string{
		`DELETE FROM runs WHERE id NOT IN (SELECT id FROM runs ORDER BY started_us DESC LIMIT 200)`,
		`DELETE FROM faults WHERE run_id NOT IN (SELECT id FROM runs)`,
		`DELETE FROM traces WHERE run_id NOT IN (SELECT id FROM runs)`,
		`DELETE FROM events WHERE run_id <> '' AND run_id NOT IN (SELECT id FROM runs)`,
	} {
		if _, err := s.db.Exec(q); err != nil {
			return err
		}
	}
	return nil
}

// Interrupt는 관리 서버가 비정상 종료해 끝나지 않은 실행과 관측을 정리한다.
func (s *Store) Interrupt() ([]model.Run, error) {
	runs, err := s.Runs()
	if err != nil {
		return nil, err
	}
	var hit []model.Run
	for _, r := range runs {
		traces, err := s.Traces(r.ID)
		if err != nil {
			return hit, err
		}
		for _, t := range traces {
			if t.Observation != model.ObsWaiting && t.Result != wire.ResultRunning {
				continue
			}
			if t.Result == wire.ResultRunning {
				t.Result, t.Error = wire.ResultError, "관리 서버가 재시작되어 결과를 확인하지 못함"
			}
			t.Observation = model.ObsPartial
			t.Notes = append(t.Notes, "관리 서버 재시작으로 관측이 중단됨")
			if err := s.SaveTrace(t); err != nil {
				return hit, err
			}
		}
		if r.Status == "ended" {
			continue
		}
		r.Status, r.EndReason = "ended", "interrupted"
		if len(traces) > 0 {
			last := traces[len(traces)-1]
			r.EndedUs = max(last.EndUs, last.StartUs, r.StartedUs)
		} else {
			r.EndedUs = r.StartedUs
		}
		if err := s.SaveRun(r); err != nil {
			return hit, err
		}
		hit = append(hit, r)
	}
	return hit, nil
}
