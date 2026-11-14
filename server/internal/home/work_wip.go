package home

type WorkWIP struct {
	ActiveCount int  `json:"activeCount"`
	Limit       int  `json:"limit"`
	Exceeded    bool `json:"exceeded"`
}

func (a *App) decorateWorkWIP(r *Request, space string, catalog *WorkStatusCatalog) error {
	ids := []string{}
	for i := range catalog.Items {
		v := &catalog.Items[i]
		if v.WIPLimit > 0 {
			if v.WorkStatusCounts != nil {
				v.WIP = &WorkWIP{ActiveCount: v.Total, Limit: v.WIPLimit, Exceeded: v.Total > v.WIPLimit}
			} else {
				ids = append(ids, v.ID)
				v.WIP = &WorkWIP{Limit: v.WIPLimit}
			}
		}
	}
	if len(ids) == 0 {
		return nil
	}
	slots, args := workPlaceholders(ids)
	args = append([]any{space, false}, args...)
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT status,COUNT(*) FROM work_items WHERE space_id=? AND archived=? AND status IN ("+slots+") GROUP BY status"), args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var count int
		if err = rows.Scan(&id, &count); err != nil {
			return err
		}
		v := catalog.find(id)
		v.WIP.ActiveCount = count
		v.WIP.Exceeded = count > v.WIPLimit
	}
	return rows.Err()
}
