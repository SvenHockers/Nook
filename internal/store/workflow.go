package store

import (
	"encoding/json"
	"errors"
	"nook/internal/model"
)

// Workflow mutation, session allocation and accepted evidence commit atomically.
func (s *Store) CommitWorkflow(w model.Workflow, expected int, session *model.Session, artifact *model.WorkflowArtifact) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	body, err := json.Marshal(w)
	if err != nil {
		return err
	}
	if expected == 0 {
		_, err = tx.Exec("INSERT INTO workflows(id,revision,body) VALUES(?,?,?)", w.ID, w.Revision, string(body))
	} else {
		result, e := tx.Exec("UPDATE workflows SET revision=?,body=? WHERE id=? AND revision=?", w.Revision, string(body), w.ID, expected)
		err = e
		if err == nil {
			n, e := result.RowsAffected()
			if e != nil {
				err = e
			} else if n != 1 {
				err = errors.New("Workflow changed; refresh before trying again")
			}
		}
	}
	if err != nil {
		return err
	}
	if session != nil {
		body, err = json.Marshal(session)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO sessions(id,body) VALUES(?,?)", session.ID, string(body)); err != nil {
			return err
		}
	}
	if artifact != nil {
		body, err = json.Marshal(artifact)
		if err != nil {
			return err
		}
		if _, err = tx.Exec("INSERT INTO workflow_artifacts(id,workflow_id,body) VALUES(?,?,?)", artifact.ID, w.ID, string(body)); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) Workflows() ([]model.Workflow, error) {
	rows, err := s.db.Query("SELECT body FROM workflows ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Workflow{}
	for rows.Next() {
		var body string
		var w model.Workflow
		if err = rows.Scan(&body); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &w); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
func (s *Store) WorkflowArtifact(workflowID, id string) (model.WorkflowArtifact, error) {
	var body string
	var a model.WorkflowArtifact
	err := s.db.QueryRow("SELECT body FROM workflow_artifacts WHERE workflow_id=? AND id=?", workflowID, id).Scan(&body)
	if err != nil {
		return a, err
	}
	err = json.Unmarshal([]byte(body), &a)
	return a, err
}
