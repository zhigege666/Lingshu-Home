package home

import (
	"context"
	"sort"
	"time"
)

func (a *App) wakeIntegrationWorker() {
	select {
	case a.integrationWake <- struct{}{}:
	default:
	}
}

// An empty schedule has no timer. Only committed configuration changes wake it;
// viewing a page or receiving a push never starts a background poll loop.
func (a *App) startIntegrationWorkers() {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		client := a.newOutboundGitHubClient()
		defer client.CloseIdleConnections()
		for a.ctx.Err() == nil {
			ids, next, err := a.integrationSchedule(a.ctx)
			if err == nil && len(ids) > 0 {
				for _, id := range ids {
					if a.ctx.Err() != nil {
						return
					}
					job, e := a.claimIntegrationTraffic(a.ctx, id)
					if e != nil {
						err = e
						break
					}
					if job == nil {
						continue
					}
					if job.source.Kind == "github-traffic" {
						a.runIntegrationTraffic(a.ctx, client, *job)
					} else {
						a.runComponentIntegration(a.ctx, *job)
					}
				}
				if err == nil {
					continue
				}
			}
			var timer *time.Timer
			var tick <-chan time.Time
			if err != nil {
				next = time.Now().Add(30 * time.Second)
			}
			if !next.IsZero() {
				delay := time.Until(next)
				if delay < 0 {
					delay = 0
				}
				timer = time.NewTimer(delay)
				tick = timer.C
			}
			select {
			case <-a.ctx.Done():
				if timer != nil {
					timer.Stop()
				}
				return
			case <-a.integrationWake:
			case <-tick:
			}
			if timer != nil {
				timer.Stop()
			}
		}
	}()
}

func (a *App) integrationSchedule(ctx context.Context) ([]string, time.Time, error) {
	if err := a.store.CheckLease(ctx); err != nil {
		return nil, time.Time{}, err
	}
	rows, err := a.store.DB.QueryContext(ctx, a.store.Query("SELECT id,next_sync_at FROM integration_sources WHERE kind IN ('github-traffic','calendar-ics','weather-open-meteo','external-json') AND enabled=?"), true)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer rows.Close()
	ids := []string{}
	var next time.Time
	now := time.Now()
	for rows.Next() {
		var id string
		var due integrationTime
		if err = rows.Scan(&id, &due); err != nil {
			return nil, time.Time{}, err
		}
		if !due.Valid || !due.Time.After(now) {
			ids = append(ids, id)
		} else if next.IsZero() || due.Time.Before(next) {
			next = due.Time
		}
	}
	if err = rows.Err(); err != nil {
		return nil, time.Time{}, err
	}
	sort.Strings(ids)
	return ids, next, nil
}
func (a *App) dueIntegrationSources(ctx context.Context) ([]string, error) {
	ids, _, err := a.integrationSchedule(ctx)
	return ids, err
}
