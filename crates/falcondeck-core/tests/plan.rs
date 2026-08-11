use falcondeck_core::PlanStep;
use serde_json::json;

#[test]
fn plan_step_round_trips_provider_identity() {
    let payload = json!({
        "id": "inspect-state",
        "step": "Inspect state",
        "status": "in_progress"
    });

    let step: PlanStep = serde_json::from_value(payload.clone()).expect("plan step");

    assert_eq!(
        serde_json::to_value(step).expect("serialized step"),
        payload
    );
}

#[test]
fn legacy_plan_step_omits_absent_identity() {
    let payload = json!({
        "step": "Inspect state",
        "status": "pending"
    });

    let step: PlanStep = serde_json::from_value(payload.clone()).expect("legacy plan step");

    assert_eq!(
        serde_json::to_value(step).expect("serialized step"),
        payload
    );
}
