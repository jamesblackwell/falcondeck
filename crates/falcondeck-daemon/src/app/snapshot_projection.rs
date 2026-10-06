//! Snapshot catalog projection without copying fields the caller omits.

use falcondeck_core::{WorkspaceAgentSummary, WorkspaceSummary};

pub(super) fn agent(source: &WorkspaceAgentSummary, include_skills: bool) -> WorkspaceAgentSummary {
    WorkspaceAgentSummary {
        provider: source.provider.clone(),
        label: source.label.clone(),
        account: source.account.clone(),
        models: source.models.clone(),
        collaboration_modes: source.collaboration_modes.clone(),
        skills: if include_skills {
            source.skills.clone()
        } else {
            Vec::new()
        },
        capabilities: source.capabilities.clone(),
        models_loading: source.models_loading,
    }
}

pub(super) fn workspace(source: &WorkspaceSummary, compact: bool) -> WorkspaceSummary {
    WorkspaceSummary {
        id: source.id.clone(),
        path: source.path.clone(),
        kind: source.kind.clone(),
        status: source.status.clone(),
        agents: source
            .agents
            .iter()
            .map(|source| agent(source, !compact))
            .collect(),
        skills: if compact {
            Vec::new()
        } else {
            source.skills.clone()
        },
        default_provider: source.default_provider.clone(),
        models: source.models.clone(),
        collaboration_modes: source.collaboration_modes.clone(),
        account: source.account.clone(),
        current_thread_id: source.current_thread_id.clone(),
        connected_at: source.connected_at,
        updated_at: source.updated_at,
        last_error: source.last_error.clone(),
        icon: source.icon.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_catalogs_match_full_projection_with_only_skills_omitted() {
        let skill = serde_json::json!({
            "id":"large-skill", "label":"Skill", "alias":"/skill",
            "availability":"codex", "providers":["codex"], "source_kind":"provider_native",
            "description":"x".repeat(1024 * 1024),
        });
        let source: WorkspaceSummary = serde_json::from_value(serde_json::json!({
            "id":"workspace", "path":"/fixture", "kind":"project", "status":"ready",
            "agents":[{
                "provider":"codex", "label":"Codex", "account":{"status":"ready", "label":"Ready"},
                "skills":[skill.clone()], "models_loading":true,
                "models":[{"id":"model", "label":"Model", "is_default":true, "supported_reasoning_efforts":[]}],
            }],
            "skills":[skill], "current_thread_id":"thread", "last_error":"fixture error",
            "connected_at":"2026-10-06T00:00:00Z", "updated_at":"2026-10-06T01:00:00Z",
        })).unwrap();
        assert_eq!(workspace(&source, false), source);
        let projected = workspace(&source, true);
        let mut expected = source.clone();
        expected.skills.clear();
        expected
            .agents
            .iter_mut()
            .for_each(|agent| agent.skills.clear());
        assert_eq!(projected, expected);
        assert_eq!(agent(&source.agents[0], false), projected.agents[0]);
        assert!(!source.skills.is_empty(), "stored catalogs remain intact");
    }
}
