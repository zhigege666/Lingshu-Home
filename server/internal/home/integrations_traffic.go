package home

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

type TrafficMetrics struct {
	Count   int64 `json:"count"`
	Uniques int64 `json:"uniques"`
}
type TrafficWindow struct {
	CapturedAt  time.Time      `json:"capturedAt"`
	WindowStart *string        `json:"windowStart"`
	WindowEnd   *string        `json:"windowEnd"`
	WindowBasis string         `json:"windowBasis"`
	Views       TrafficMetrics `json:"views"`
	Clones      TrafficMetrics `json:"clones"`
}
type TrafficDaily struct {
	Date             string          `json:"date"`
	Views            *TrafficMetrics `json:"views"`
	Clones           *TrafficMetrics `json:"clones"`
	IsPartial        bool            `json:"isPartial"`
	ObservedAt       *time.Time      `json:"observedAt"`
	ViewsObservedAt  *time.Time      `json:"viewsObservedAt"`
	ClonesObservedAt *time.Time      `json:"clonesObservedAt"`
}
type TrafficPath struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Count   int64  `json:"count"`
	Uniques int64  `json:"uniques"`
}
type TrafficReferrer struct {
	Referrer string `json:"referrer"`
	Count    int64  `json:"count"`
	Uniques  int64  `json:"uniques"`
}
type TrafficAuxiliaryStatus struct {
	State         string     `json:"state"`
	LastSuccessAt *time.Time `json:"lastSuccessAt"`
	Code          string     `json:"code,omitempty"`
}
type GitHubTrafficData struct {
	Repository struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
		URL   string `json:"url"`
	} `json:"repository"`
	Baseline        TrafficWindow     `json:"baseline"`
	Current         TrafficWindow     `json:"current"`
	Daily           []TrafficDaily    `json:"daily"`
	PopularPaths    []TrafficPath     `json:"popularPaths"`
	Referrers       []TrafficReferrer `json:"referrers"`
	AuxiliaryStatus struct {
		Paths     TrafficAuxiliaryStatus `json:"paths"`
		Referrers TrafficAuxiliaryStatus `json:"referrers"`
	} `json:"auxiliaryStatus"`
}
type integrationTrafficPoint struct {
	Timestamp time.Time `json:"timestamp"`
	Count     *int64    `json:"count"`
	Uniques   *int64    `json:"uniques"`
}
type integrationTrafficTotals struct {
	Count   *int64                    `json:"count"`
	Uniques *int64                    `json:"uniques"`
	Views   []integrationTrafficPoint `json:"views"`
	Clones  []integrationTrafficPoint `json:"clones"`
}
type integrationTrafficFetch struct {
	window                     TrafficWindow
	views, clones              map[string]TrafficMetrics
	paths                      []TrafficPath
	referrers                  []TrafficReferrer
	pathsError, referrersError *IntegrationFailure
}

func integrationTrafficFailure(code string) *IntegrationFailure {
	return &IntegrationFailure{Code: code, Message: "GitHub traffic could not be refreshed. Check the repository, credential permissions and upstream availability.", At: time.Now().UTC()}
}
func integrationGitHubClient() *http.Client {
	dialer := &net.Dialer{Timeout: 4 * time.Second, KeepAlive: -1}
	return integrationGitHubClientWithDial(dialer.DialContext)
}
func integrationGitHubClientWithDial(dial iconDialContext) *http.Client {
	transport := &http.Transport{Proxy: nil, DialContext: iconPinnedDial(net.DefaultResolver, dial), DisableKeepAlives: true, DisableCompression: true, TLSHandshakeTimeout: 4 * time.Second, ResponseHeaderTimeout: 12 * time.Second, MaxResponseHeaderBytes: 32 << 10}
	return &http.Client{Timeout: 20 * time.Second, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func fetchIntegrationGitHub(ctx context.Context, client *http.Client, source IntegrationSource, token, endpoint string) ([]byte, *IntegrationFailure) {
	switch endpoint {
	case "views?per=day", "clones?per=day", "popular/paths", "popular/referrers":
	default:
		return nil, integrationTrafficFailure("github_invalid_endpoint")
	}
	if !integrationOwnerPattern.MatchString(source.Connection["owner"]) || !integrationRepoPattern.MatchString(source.Connection["repo"]) {
		return nil, integrationTrafficFailure("github_invalid_repository")
	}
	target := "https://api.github.com/repos/" + url.PathEscape(source.Connection["owner"]) + "/" + url.PathEscape(source.Connection["repo"]) + "/traffic/" + endpoint
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, integrationTrafficFailure("github_invalid_request")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	request.Header.Set("User-Agent", "Lingshu-Home/traffic")
	response, err := client.Do(request)
	if err != nil {
		return nil, integrationTrafficFailure("github_unreachable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, integrationTrafficFailure("github_http_" + strconv.Itoa(response.StatusCode))
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(body) > 1<<20 {
		return nil, integrationTrafficFailure("github_invalid_response")
	}
	return body, nil
}
func validateTrafficTotals(in integrationTrafficTotals, kind string, now time.Time) (TrafficMetrics, map[string]TrafficMetrics, error) {
	if in.Count == nil || in.Uniques == nil || *in.Count < 0 || *in.Uniques < 0 || *in.Uniques > *in.Count {
		return TrafficMetrics{}, nil, errors.New("invalid aggregate metrics")
	}
	points := in.Views
	if kind == "clones" {
		points = in.Clones
	}
	if points == nil || len(points) > 32 {
		return TrafficMetrics{}, nil, errors.New("missing or excessive daily metrics")
	}
	result := map[string]TrafficMetrics{}
	today := time.Date(now.UTC().Year(), now.UTC().Month(), now.UTC().Day(), 0, 0, 0, 0, time.UTC)
	for _, point := range points {
		timestamp := point.Timestamp.UTC()
		day := timestamp.Format("2006-01-02")
		if point.Count == nil || point.Uniques == nil || *point.Count < 0 || *point.Uniques < 0 || *point.Uniques > *point.Count {
			return TrafficMetrics{}, nil, errors.New("invalid daily metrics")
		}
		if !timestamp.Equal(timestamp.Truncate(24*time.Hour)) || timestamp.After(today) || timestamp.Before(today.AddDate(0, 0, -32)) {
			return TrafficMetrics{}, nil, errors.New("invalid daily timestamp")
		}
		if _, exists := result[day]; exists {
			return TrafficMetrics{}, nil, errors.New("duplicate daily timestamp")
		}
		result[day] = TrafficMetrics{Count: *point.Count, Uniques: *point.Uniques}
	}
	return TrafficMetrics{Count: *in.Count, Uniques: *in.Uniques}, result, nil
}
func decodeTrafficPaths(body []byte) ([]TrafficPath, error) {
	var input []struct {
		Path    string `json:"path"`
		Title   string `json:"title"`
		Count   *int64 `json:"count"`
		Uniques *int64 `json:"uniques"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	if input == nil {
		return nil, errors.New("missing popular paths")
	}
	output := make([]TrafficPath, 0, len(input))
	for _, item := range input {
		if item.Count == nil || item.Uniques == nil {
			return nil, errors.New("missing popular path metrics")
		}
		output = append(output, TrafficPath{Path: item.Path, Title: item.Title, Count: *item.Count, Uniques: *item.Uniques})
	}
	return output, validateTrafficPaths(output)
}
func decodeTrafficReferrers(body []byte) ([]TrafficReferrer, error) {
	var input []struct {
		Referrer string `json:"referrer"`
		Count    *int64 `json:"count"`
		Uniques  *int64 `json:"uniques"`
	}
	if err := json.Unmarshal(body, &input); err != nil {
		return nil, err
	}
	if input == nil {
		return nil, errors.New("missing referrers")
	}
	output := make([]TrafficReferrer, 0, len(input))
	for _, item := range input {
		if item.Count == nil || item.Uniques == nil {
			return nil, errors.New("missing referrer metrics")
		}
		output = append(output, TrafficReferrer{Referrer: item.Referrer, Count: *item.Count, Uniques: *item.Uniques})
	}
	return output, validateTrafficReferrers(output)
}

func validateTrafficPaths(paths []TrafficPath) error {
	if paths == nil || len(paths) > 10 {
		return errors.New("invalid popular paths")
	}
	for _, p := range paths {
		if !strings.HasPrefix(p.Path, "/") || strings.HasPrefix(p.Path, "//") || len(p.Path) > 4096 || strings.ContainsAny(p.Path, "\\\r\n\x00") || len(p.Title) > 2000 || p.Count < 0 || p.Uniques < 0 || p.Uniques > p.Count {
			return errors.New("invalid popular path")
		}
	}
	return nil
}
func validateTrafficReferrers(referrers []TrafficReferrer) error {
	if referrers == nil || len(referrers) > 10 {
		return errors.New("invalid referrers")
	}
	for _, r := range referrers {
		if len(r.Referrer) < 1 || len(r.Referrer) > 512 || strings.ContainsAny(r.Referrer, "\r\n\x00") || r.Count < 0 || r.Uniques < 0 || r.Uniques > r.Count {
			return errors.New("invalid referrer")
		}
	}
	return nil
}
func fetchGitHubTraffic(ctx context.Context, client *http.Client, source IntegrationSource, token string) (integrationTrafficFetch, *IntegrationFailure) {
	var result integrationTrafficFetch
	result.window.WindowBasis = "github-last-14-days"
	endpoints := []string{"views?per=day", "clones?per=day", "popular/paths", "popular/referrers"}
	bodies := make([][]byte, 4)
	failures := make([]*IntegrationFailure, 4)
	var workers sync.WaitGroup
	for i, endpoint := range endpoints {
		workers.Add(1)
		go func(i int, endpoint string) {
			defer workers.Done()
			bodies[i], failures[i] = fetchIntegrationGitHub(ctx, client, source, token, endpoint)
		}(i, endpoint)
	}
	workers.Wait()
	for i := 0; i < 2; i++ {
		if failures[i] != nil {
			return result, failures[i]
		}
	}
	now := time.Now().UTC()
	var views, clones integrationTrafficTotals
	if json.Unmarshal(bodies[0], &views) != nil || json.Unmarshal(bodies[1], &clones) != nil {
		return result, integrationTrafficFailure("github_invalid_response")
	}
	var err error
	result.window.Views, result.views, err = validateTrafficTotals(views, "views", now)
	if err != nil {
		return result, integrationTrafficFailure("github_invalid_response")
	}
	result.window.Clones, result.clones, err = validateTrafficTotals(clones, "clones", now)
	if err != nil {
		return result, integrationTrafficFailure("github_invalid_response")
	}
	result.pathsError = failures[2]
	if failures[2] == nil {
		result.paths, err = decodeTrafficPaths(bodies[2])
		if err != nil {
			result.paths = nil
			result.pathsError = integrationTrafficFailure("github_invalid_response")
		}
	}
	result.referrersError = failures[3]
	if failures[3] == nil {
		result.referrers, err = decodeTrafficReferrers(bodies[3])
		if err != nil {
			result.referrers = nil
			result.referrersError = integrationTrafficFailure("github_invalid_response")
		}
	}
	// GitHub reports a rolling last-14-days aggregate but no exact aggregate boundary fields.
	// Preserve unknown window bounds, and do not sum daily unique counts into window uniques.
	result.window.CapturedAt = time.Now().UTC()
	return result, nil
}

type integrationTrafficJob struct {
	source             IntegrationSource
	epoch, userVersion int64
}

func (a *App) integrationSourceAccount(ctx context.Context, q Queryer, s IntegrationSource) (Settings, *User, error) {
	settings, err := a.loadSettings(ctx, q)
	if err != nil {
		return settings, nil, err
	}
	user, err := a.loadUser(ctx, q, s.createdBy)
	if err != nil {
		return settings, nil, err
	}
	if user == nil || !canLogin(user, settings) {
		return settings, nil, forbidden()
	}
	request := (&http.Request{Method: "POST", URL: &url.URL{Path: "/internal/source-sync"}}).WithContext(ctx)
	r := &Request{App: a, HTTP: request, Q: q, Settings: settings, User: user}
	if _, err := r.requireSpace(s.SpaceID, true); err != nil {
		return settings, nil, err
	}
	return settings, user, nil
}
func (a *App) claimIntegrationTraffic(ctx context.Context, id string) (*integrationTrafficJob, error) {
	var job *integrationTrafficJob
	err := a.integrationTransaction(ctx, func(q Queryer) error {
		source, err := a.loadIntegrationSource(ctx, q, id)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		if !source.Enabled || !integrationPollingKind(source.Kind) || (source.NextSyncAt != nil && source.NextSyncAt.After(now)) {
			return nil
		}
		next := now.Add(time.Duration(source.Sync.IntervalSeconds) * time.Second)
		if _, err := q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET next_sync_at=? WHERE id=?"), integrationStamp(next), id); err != nil {
			return err
		}
		settings, user, err := a.integrationSourceAccount(ctx, q, source)
		if err != nil {
			var api *APIError
			if !errors.As(err, &api) {
				return err
			}
			failure := integrationTrafficFailure("account_unavailable")
			failure.Message = "The source account no longer has permission to synchronize this space."
			encoded, _ := json.Marshal(failure)
			_, err = q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET last_error_json=? WHERE id=?"), string(encoded), id)
			return err
		}
		job = &integrationTrafficJob{source: source, epoch: settings.AuthEpoch, userVersion: user.Version}
		return nil
	})
	return job, err
}
func (a *App) runIntegrationTraffic(ctx context.Context, client *http.Client, job integrationTrafficJob) {
	ctx, done := a.beginNetworkOperation(ctx)
	defer done()
	var fetched integrationTrafficFetch
	var failure *IntegrationFailure
	token, err := a.decryptIntegrationSecret(job.source.ID, job.source.credentialCipher)
	if err != nil {
		failure = integrationTrafficFailure("credential_unavailable")
	} else {
		fetched, failure = fetchGitHubTraffic(ctx, client, job.source, token)
	}
	if ctx.Err() != nil {
		return
	}
	_ = a.integrationTransaction(ctx, func(q Queryer) error {
		if err := a.checkNetworkOperation(ctx, q); err != nil {
			return err
		}
		source, err := a.loadIntegrationSource(ctx, q, job.source.ID)
		if err != nil {
			return err
		}
		if !source.Enabled || source.ConfigRevision != job.source.ConfigRevision {
			return nil
		}
		settings, user, err := a.integrationSourceAccount(ctx, q, source)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) {
				return nil
			}
			return err
		}
		if settings.AuthEpoch != job.epoch || user.Version != job.userVersion {
			return nil
		}
		if failure != nil {
			encoded, _ := json.Marshal(failure)
			_, err := q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET last_error_json=? WHERE id=?"), string(encoded), source.ID)
			return err
		}
		return a.persistGitHubTraffic(ctx, q, source, fetched)
	})
}

func integrationMetricValues(m map[string]TrafficMetrics, day string, at time.Time) (any, any, any) {
	value, exists := m[day]
	if !exists {
		return nil, nil, nil
	}
	return value.Count, value.Uniques, integrationStamp(at)
}
func (a *App) persistGitHubTraffic(ctx context.Context, q Queryer, source IntegrationSource, result integrationTrafficFetch) error {
	var oldRaw []byte
	var revision int64
	var old GitHubTrafficData
	err := q.QueryRowContext(ctx, a.store.Query("SELECT revision,data_json FROM integration_snapshots WHERE source_id=?"), source.ID).Scan(&revision, &oldRaw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if len(oldRaw) > 0 {
		if err := json.Unmarshal(oldRaw, &old); err != nil {
			return err
		}
	}
	if revision == math.MaxInt64 {
		return conflict("snapshot revision limit reached")
	}
	now := result.window.CapturedAt.UTC()
	if now.IsZero() {
		return errors.New("traffic capture timestamp is required")
	}
	baselineJSON, err := json.Marshal(result.window)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, a.store.Query("INSERT INTO integration_traffic_baselines(source_id,data_json) VALUES(?,?) ON CONFLICT(source_id) DO NOTHING"), source.ID, string(baselineJSON))
	if err != nil {
		return err
	}
	var savedBaseline []byte
	if err := q.QueryRowContext(ctx, a.store.Query("SELECT data_json FROM integration_traffic_baselines WHERE source_id=?"), source.ID).Scan(&savedBaseline); err != nil {
		return err
	}
	var data GitHubTrafficData
	if err := json.Unmarshal(savedBaseline, &data.Baseline); err != nil {
		return err
	}
	data.Repository.Owner = source.Connection["owner"]
	data.Repository.Name = source.Connection["repo"]
	data.Repository.URL = "https://github.com/" + url.PathEscape(data.Repository.Owner) + "/" + url.PathEscape(data.Repository.Name)
	data.Current = result.window
	data.PopularPaths = []TrafficPath{}
	data.Referrers = []TrafficReferrer{}
	days := map[string]bool{}
	for day := range result.views {
		days[day] = true
	}
	for day := range result.clones {
		days[day] = true
	}
	for day := range days {
		views, viewUniques, viewsAt := integrationMetricValues(result.views, day, now)
		clones, cloneUniques, clonesAt := integrationMetricValues(result.clones, day, now)
		_, err := q.ExecContext(ctx, a.store.Query(`INSERT INTO integration_traffic_daily(source_id,day,views_count,views_uniques,clones_count,clones_uniques,observed_at,views_observed_at,clones_observed_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,day) DO UPDATE SET views_count=COALESCE(excluded.views_count,integration_traffic_daily.views_count),views_uniques=COALESCE(excluded.views_uniques,integration_traffic_daily.views_uniques),clones_count=COALESCE(excluded.clones_count,integration_traffic_daily.clones_count),clones_uniques=COALESCE(excluded.clones_uniques,integration_traffic_daily.clones_uniques),observed_at=excluded.observed_at,views_observed_at=COALESCE(excluded.views_observed_at,integration_traffic_daily.views_observed_at),clones_observed_at=COALESCE(excluded.clones_observed_at,integration_traffic_daily.clones_observed_at)`), source.ID, day, views, viewUniques, clones, cloneUniques, integrationStamp(now), viewsAt, clonesAt)
		if err != nil {
			return err
		}
	}
	rows, err := q.QueryContext(ctx, a.store.Query("SELECT day,views_count,views_uniques,clones_count,clones_uniques,observed_at,views_observed_at,clones_observed_at FROM integration_traffic_daily WHERE source_id=? ORDER BY day"), source.ID)
	if err != nil {
		return err
	}
	observed := map[string]TrafficDaily{}
	ordered := []string{}
	for rows.Next() {
		var day TrafficDaily
		var views, viewUniques, clones, cloneUniques sql.NullInt64
		var at, viewsAt, clonesAt integrationTime
		if err := rows.Scan(&day.Date, &views, &viewUniques, &clones, &cloneUniques, &at, &viewsAt, &clonesAt); err != nil {
			rows.Close()
			return err
		}
		if views.Valid {
			day.Views = &TrafficMetrics{Count: views.Int64, Uniques: viewUniques.Int64}
		}
		if clones.Valid {
			day.Clones = &TrafficMetrics{Count: clones.Int64, Uniques: cloneUniques.Int64}
		}
		day.ObservedAt = at.Pointer()
		day.ViewsObservedAt = viewsAt.Pointer()
		day.ClonesObservedAt = clonesAt.Pointer()
		day.IsPartial = day.Date == now.Format("2006-01-02") || (viewsAt.Valid && viewsAt.Time.Format("2006-01-02") <= day.Date) || (clonesAt.Valid && clonesAt.Time.Format("2006-01-02") <= day.Date)
		observed[day.Date] = day
		ordered = append(ordered, day.Date)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	data.Daily = []TrafficDaily{}
	if len(ordered) > 0 {
		first, err := time.Parse("2006-01-02", ordered[0])
		if err != nil {
			return err
		}
		last, err := time.Parse("2006-01-02", ordered[len(ordered)-1])
		if err != nil {
			return err
		}
		for date := first; !date.After(last); date = date.AddDate(0, 0, 1) {
			key := date.Format("2006-01-02")
			day, exists := observed[key]
			if !exists {
				day = TrafficDaily{Date: key, IsPartial: key == now.Format("2006-01-02")}
			}
			data.Daily = append(data.Daily, day)
		}
	}
	if result.pathsError == nil {
		data.PopularPaths = result.paths
		data.AuxiliaryStatus.Paths = TrafficAuxiliaryStatus{State: "ok", LastSuccessAt: &now}
	} else {
		if old.PopularPaths != nil {
			data.PopularPaths = old.PopularPaths
		}
		data.AuxiliaryStatus.Paths = old.AuxiliaryStatus.Paths
		data.AuxiliaryStatus.Paths.State = "unavailable"
		if data.AuxiliaryStatus.Paths.LastSuccessAt != nil {
			data.AuxiliaryStatus.Paths.State = "stale"
		}
		data.AuxiliaryStatus.Paths.Code = result.pathsError.Code
	}
	if result.referrersError == nil {
		data.Referrers = result.referrers
		data.AuxiliaryStatus.Referrers = TrafficAuxiliaryStatus{State: "ok", LastSuccessAt: &now}
	} else {
		if old.Referrers != nil {
			data.Referrers = old.Referrers
		}
		data.AuxiliaryStatus.Referrers = old.AuxiliaryStatus.Referrers
		data.AuxiliaryStatus.Referrers.State = "unavailable"
		if data.AuxiliaryStatus.Referrers.LastSuccessAt != nil {
			data.AuxiliaryStatus.Referrers.State = "stale"
		}
		data.AuxiliaryStatus.Referrers.Code = result.referrersError.Code
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, a.store.Query(`INSERT INTO integration_snapshots(source_id,revision,source_sequence,data_json,source_updated_at,received_at) VALUES(?,?,NULL,?,NULL,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json,source_updated_at=NULL,received_at=excluded.received_at`), source.ID, revision+1, string(encoded), integrationStamp(now))
	if err != nil {
		return err
	}
	_, err = q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET last_success_at=?,last_error_json=NULL WHERE id=?"), integrationStamp(now), source.ID)
	return err
}

// Keep failure messages independent of upstream response bodies and authorization headers.
func (f *IntegrationFailure) Error() string { return fmt.Sprintf("%s: %s", f.Code, f.Message) }
