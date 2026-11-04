package home

import "database/sql"

type navigationCreateCategory struct {
	ID string `json:"id"`
	categoryInput
}
type navigationCreateLink struct {
	ID string `json:"id"`
	linkInput
}

// ON CONFLICT DO NOTHING never overwrites an existing or foreign row.
func checkNavigationInsert(result sql.Result, err error) error {
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return conflict("The proposed record ID is unavailable.")
	}
	return nil
}

func (a *App) insertNavigationCategory(r *Request, c Category) error {
	return checkNavigationInsert(r.Q.ExecContext(r.HTTP.Context(), a.store.Query("INSERT INTO categories(id,space_id,parent_id,name,icon,sort_order) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"), c.ID, c.SpaceID, nullableID(c.ParentID), c.Name, c.Icon, c.SortOrder))
}

func (a *App) createNavigationRows(r *Request, spaceID string, in navigationEditInput) (map[string]bool, map[string]bool, error) {
	cats, links := map[string]bool{}, map[string]bool{}
	for _, row := range in.CreateCategories {
		if !validID(row.ID) || cats[row.ID] {
			return nil, nil, invalid("New category IDs must be unique 32-character lowercase hexadecimal strings.")
		}
		if err := a.validateCategory(r, spaceID, row.ID, &row.categoryInput); err != nil {
			return nil, nil, navigationEditError(err, "category", row.ID, "")
		}
		c := Category{ID: row.ID, SpaceID: spaceID, Name: row.Name, ParentID: row.ParentID, Icon: row.Icon, SortOrder: row.SortOrder}
		if err := a.insertNavigationCategory(r, c); err != nil {
			return nil, nil, navigationEditError(err, "category", row.ID, "id")
		}
		cats[row.ID] = true
	}
	for _, row := range in.CreateLinks {
		if !validID(row.ID) || links[row.ID] {
			return nil, nil, invalid("New link IDs must be unique 32-character lowercase hexadecimal strings.")
		}
		if row.ExpectedUpdatedAt != "" {
			return nil, nil, invalid("expectedUpdatedAt applies only to an existing bookmark.")
		}
		if _, err := a.insertLinkWithID(r, spaceID, row.ID, row.linkInput); err != nil {
			return nil, nil, navigationEditError(err, "link", row.ID, navigationEditLinkField(err))
		}
		links[row.ID] = true
	}
	return cats, links, nil
}
