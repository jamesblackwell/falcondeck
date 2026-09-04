use falcondeck_core::{
    ConsumeProviderResetCreditOutcome, ConsumeProviderResetCreditRequest,
    ConsumeProviderResetCreditResponse, ProviderUsage, ProviderUsageOverview,
    ProviderUsageResetCredit, ProviderUsageResetCredits, ProviderUsageWindow,
};
use serde_json::json;

#[test]
fn provider_usage_ok_round_trips() {
    let payload = json!({
        "status": "ok",
        "account_email": "dev@example.com",
        "plan_label": "Pro",
        "windows": [
            {
                "label": "Current session",
                "used_percent": 42,
                "resets_at": "2026-08-18T22:00:00.000Z"
            },
            {
                "label": "Weekly limit",
                "used_percent": 7,
                "resets_at": null,
                "cost": {
                    "used_usd_cents": 120,
                    "limit_usd_cents": 10_000
                }
            }
        ]
    });

    let usage: ProviderUsage = serde_json::from_value(payload.clone()).expect("usage");

    assert_eq!(
        serde_json::to_value(usage).expect("serialized usage"),
        payload
    );
}

#[test]
fn provider_usage_status_variants_omit_optional_fields() {
    for status in ["not_installed", "unauthenticated", "expired"] {
        let payload = json!({ "status": status });
        let usage: ProviderUsage = serde_json::from_value(payload.clone()).expect("status");
        assert_eq!(
            serde_json::to_value(usage).expect("serialized status"),
            payload
        );
    }
}

#[test]
fn provider_usage_error_defaults_optional_fields() {
    let payload = json!({
        "status": "error",
        "message": "Codex usage request failed (HTTP 503)."
    });

    let usage: ProviderUsage = serde_json::from_value(payload).expect("error usage");

    match usage {
        ProviderUsage::Error {
            message,
            plan_label,
            account_email,
        } => {
            assert_eq!(message, "Codex usage request failed (HTTP 503).");
            assert_eq!(plan_label, None);
            assert_eq!(account_email, None);
        }
        other => panic!("expected error variant, got {other:?}"),
    }
}

#[test]
fn provider_usage_window_tolerates_missing_optionals() {
    let window: ProviderUsageWindow =
        serde_json::from_value(json!({ "label": "Weekly limit", "used_percent": 18 }))
            .expect("window");

    assert_eq!(window.resets_at, None);
    assert_eq!(window.cost, None);
}

#[test]
fn provider_usage_ok_defaults_missing_reset_credits() {
    let usage: ProviderUsage = serde_json::from_value(json!({
        "status": "ok",
        "account_email": null,
        "plan_label": "Plus",
        "windows": []
    }))
    .expect("usage");

    match usage {
        ProviderUsage::Ok { reset_credits, .. } => assert_eq!(reset_credits, None),
        other => panic!("expected ok variant, got {other:?}"),
    }
}

#[test]
fn provider_usage_ok_round_trips_reset_credits() {
    let payload = json!({
        "status": "ok",
        "account_email": null,
        "plan_label": "Pro",
        "windows": [],
        "reset_credits": {
            "available_count": 2,
            "credits": [
                {
                    "id": "RateLimitResetCredit_1",
                    "title": "Full reset",
                    "expires_at": "2026-09-21T00:02:00.000Z"
                },
                {
                    "id": "RateLimitResetCredit_2",
                    "title": "Full reset",
                    "expires_at": "2026-10-04T02:11:00.000Z",
                    "description": "One free rate limit reset"
                }
            ]
        }
    });

    let usage: ProviderUsage = serde_json::from_value(payload.clone()).expect("usage");
    match &usage {
        ProviderUsage::Ok {
            reset_credits: Some(credits),
            ..
        } => {
            assert_eq!(credits.available_count, 2);
            assert_eq!(credits.credits[0].id, "RateLimitResetCredit_1");
            assert_eq!(
                credits.credits[1].description.as_deref(),
                Some("One free rate limit reset")
            );
        }
        other => panic!("expected ok with reset credits, got {other:?}"),
    }
    assert_eq!(
        serde_json::to_value(usage).expect("serialized usage"),
        payload
    );
}

#[test]
fn consume_reset_credit_request_defaults_optional_ids() {
    let request: ConsumeProviderResetCreditRequest =
        serde_json::from_value(json!({})).expect("request");
    assert_eq!(request, ConsumeProviderResetCreditRequest::default());
}

#[test]
fn consume_reset_credit_response_round_trips() {
    let payload = json!({
        "outcome": "nothing_to_reset",
        "usage": {
            "codex": { "status": "unauthenticated" },
            "claude_code": { "status": "not_installed" },
            "grok": { "status": "not_installed" },
            "cursor": { "status": "not_installed" },
            "agy": { "status": "not_installed" },
            "zai": { "status": "not_installed" }
        }
    });
    let response: ConsumeProviderResetCreditResponse =
        serde_json::from_value(payload.clone()).expect("response");
    assert_eq!(
        response.outcome,
        ConsumeProviderResetCreditOutcome::NothingToReset
    );
    assert_eq!(
        serde_json::to_value(response).expect("serialized response"),
        payload
    );
}

#[test]
fn provider_usage_reset_credit_tolerates_missing_optionals() {
    let credit: ProviderUsageResetCredit = serde_json::from_value(json!({
        "id": "RateLimitResetCredit_1",
        "title": "Full reset"
    }))
    .expect("credit");
    assert_eq!(credit.expires_at, None);
    assert_eq!(credit.description, None);
    let credits: ProviderUsageResetCredits = serde_json::from_value(json!({
        "available_count": 1
    }))
    .expect("credits");
    assert!(credits.credits.is_empty());
}

#[test]
fn provider_usage_overview_round_trips() {
    let payload = json!({
        "codex": {
            "status": "ok",
            "account_email": null,
            "plan_label": "Plus",
            "windows": []
        },
        "claude_code": { "status": "unauthenticated" },
        "grok": { "status": "not_installed" },
        "cursor": { "status": "not_installed" },
        "agy": { "status": "not_installed" },
        "zai": { "status": "not_installed" }
    });

    let overview: ProviderUsageOverview =
        serde_json::from_value(payload.clone()).expect("overview");

    assert_eq!(
        serde_json::to_value(overview).expect("serialized overview"),
        payload
    );
}

#[test]
fn provider_usage_overview_defaults_missing_grok() {
    let overview: ProviderUsageOverview = serde_json::from_value(json!({
        "codex": { "status": "unauthenticated" },
        "claude_code": { "status": "not_installed" }
    }))
    .expect("overview");

    assert_eq!(overview.grok, ProviderUsage::NotInstalled);
    assert_eq!(overview.cursor, ProviderUsage::NotInstalled);
    assert_eq!(overview.agy, ProviderUsage::NotInstalled);
    assert_eq!(overview.zai, ProviderUsage::NotInstalled);
    assert_eq!(overview.refreshed_at, None);
}

#[test]
fn provider_usage_overview_defaults_missing_cursor() {
    let overview: ProviderUsageOverview = serde_json::from_value(json!({
        "codex": { "status": "unauthenticated" },
        "claude_code": { "status": "not_installed" },
        "grok": { "status": "unauthenticated" }
    }))
    .expect("overview");

    assert_eq!(overview.cursor, ProviderUsage::NotInstalled);
    assert_eq!(overview.agy, ProviderUsage::NotInstalled);
    assert_eq!(overview.zai, ProviderUsage::NotInstalled);
    assert_eq!(overview.refreshed_at, None);
}
