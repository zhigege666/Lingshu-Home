package home

import "encoding/json"

func (a *App) recordWorkMetrics(r *Request, space, item, action, stamp string, changes []WorkActivityChange) error {
	before, after := "", ""
	found := false
	for _, change := range changes {
		if change.Field == "status" {
			var b, v struct {
				Type string `json:"type"`
			}
			if len(change.Before) > 0 {
				if err := json.Unmarshal(change.Before, &b); err != nil {
					return err
				}
			}
			if len(change.After) > 0 {
				if err := json.Unmarshal(change.After, &v); err != nil {
					return err
				}
			}
			before, after, found = b.Type, v.Type, true
			break
		}
	}
	if !found {
		return nil
	}
	semantic := action == "status_definition" || action == "status_migrate"
	if semantic {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_metric_intervals SET ended_at=?,valid=?,outcome='invalidated' WHERE item_id=? AND kind='cycle' AND ended_at=''"), stamp, false, item); err != nil {
			return err
		}
	} else if after == "doing" && before != "doing" {
		if _, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_metric_intervals(id,space_id,item_id,kind,started_at) SELECT ?,?,?,'cycle',? WHERE NOT EXISTS(SELECT 1 FROM work_metric_intervals WHERE item_id=? AND kind='cycle' AND ended_at='')"), newID(), space, item, stamp, item); err != nil {
			return err
		}
	} else if action != "create" && after != before && (after == "done" || after == "canceled") {
		result, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_metric_intervals SET ended_at=?,outcome=? WHERE item_id=? AND kind='cycle' AND ended_at=''"), stamp, after, item)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n == 0 && after == "done" {
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_metric_intervals(id,space_id,item_id,kind,ended_at,valid,outcome) VALUES(?,?,?,'cycle',?,?,'done')"), newID(), space, item, stamp, false); err != nil {
				return err
			}
		}
	}
	// The flag comes from the existing authorized space query. Empty spaces do
	// not query dependency tables on ordinary creation, updates or moves.
	if r.WorkSpaceContext != nil && r.WorkSpaceContext.ID == space && r.WorkSpaceContext.WorkRelationsCount > 0 {
		return a.syncWorkBlockedMetrics(r, space, item, stamp, semantic)
	}
	return nil
}
func (a *App) syncWorkBlockedMetrics(r *Request, space, item, stamp string, invalidate bool) error {
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT w.id,CASE WHEN "+workBlockedPredicate("w")+" THEN TRUE ELSE FALSE END,COALESCE(m.id,'') FROM work_items w LEFT JOIN work_metric_intervals m ON m.item_id=w.id AND m.kind='blocked' AND m.ended_at='' WHERE w.space_id=? AND (w.id=? OR w.id IN (SELECT item_id FROM work_dependencies WHERE space_id=? AND blocked_by_id=?))"), space, item, space, item)
	if err != nil {
		return err
	}
	type state struct {
		id, interval string
		blocked      bool
	}
	values := []state{}
	for rows.Next() {
		var v state
		if err = rows.Scan(&v.id, &v.blocked, &v.interval); err != nil {
			rows.Close()
			return err
		}
		values = append(values, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range values {
		if v.interval != "" && (!v.blocked || invalidate) {
			outcome := "resolved"
			if invalidate {
				outcome = "invalidated"
			}
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE work_metric_intervals SET ended_at=?,outcome=? WHERE id=?"), stamp, outcome, v.interval); err != nil {
				return err
			}
			v.interval = ""
		}
		if v.blocked && v.interval == "" {
			start := stamp
			if invalidate {
				start = ""
			}
			if _, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO work_metric_intervals(id,space_id,item_id,kind,started_at,valid) VALUES(?,?,?,'blocked',?,?)"), newID(), space, v.id, start, !invalidate); err != nil {
				return err
			}
		}
	}
	return nil
}
