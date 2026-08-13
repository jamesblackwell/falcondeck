use std::{net::SocketAddr, path::PathBuf};

use chrono::Duration;
use falcondeck_core::{
    ClaimPairingRequest, ClaimPairingResponse, EncryptedEnvelope, EncryptionVariant,
    IdentityVariant, PairingChallengeRequest, PairingChallengeResponse, PairingPublicKeyBundle,
    PairingStatus, PairingStatusResponse, RelayClientMessage, RelayServerMessage, RelayUpdate,
    RelayUpdateBody, RelayUpdatesResponse, RelayWebSocketTicketResponse, StartPairingRequest,
    StartPairingResponse, SubmitQueuedActionRequest, TrustedDevicesResponse,
    crypto::{
        LocalBoxKeyPair, LocalIdentityKeyPair, build_pairing_public_key_bundle, encrypt_json,
        generate_data_key, sign_pairing_claim_challenge,
    },
};
use falcondeck_relay::{AppState, RetentionConfig, router};
use futures_util::{SinkExt, StreamExt};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use tempfile::TempDir;
use tokio::{
    net::TcpListener,
    task::JoinHandle,
    time::{Duration as TokioDuration, timeout},
};
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct TestServer {
    temp_dir: Option<TempDir>,
    task: JoinHandle<()>,
    http_base: String,
    ws_base: String,
    state: AppState,
}

#[tokio::test]
async fn pairing_flow_and_history_round_trip() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("James Mac".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let pending = get_json::<PairingStatusResponse>(
        &client,
        &format!("{}/v1/pairings/{}", server.http_base, pairing.pairing_id),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(pending.status, PairingStatus::Pending);
    assert_eq!(pending.label.as_deref(), Some("James Mac"));

    let claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("Phone"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    let claimed = get_json::<PairingStatusResponse>(
        &client,
        &format!("{}/v1/pairings/{}", server.http_base, pairing.pairing_id),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(claimed.status, PairingStatus::Claimed);
    assert_eq!(
        claimed.session_id.as_deref(),
        Some(claim.session_id.as_str())
    );
    assert!(claimed.client_bundle.is_some());
    assert!(claim.daemon_bundle.is_some());

    let updates = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    assert!(updates.updates.is_empty());
    assert_eq!(updates.next_seq, 1);
}

#[tokio::test]
async fn additional_pairings_attach_new_devices_to_the_same_session() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, first_claim) = create_claimed_session(&client, &server.http_base).await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(pairing.session_id.clone()),
            daemon_token: Some(pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    assert_eq!(second_pairing.session_id, pairing.session_id);
    assert_eq!(second_pairing.daemon_token, pairing.daemon_token);

    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &second_pairing.pairing_code,
        Some("tablet"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    assert_eq!(second_claim.session_id, first_claim.session_id);
    assert_ne!(second_claim.device_id, first_claim.device_id);

    let devices = get_json::<TrustedDevicesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/devices",
            server.http_base, first_claim.session_id
        ),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(devices.devices.len(), 2);
    assert_eq!(
        devices
            .devices
            .iter()
            .filter(|device| device.status == falcondeck_core::TrustedDeviceStatus::Active)
            .count(),
        2
    );
}

#[tokio::test]
async fn revoking_twice_purges_the_device_entirely() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;
    let devices_url = format!(
        "{}/v1/sessions/{}/devices",
        server.http_base, claim.session_id
    );
    let revoke_url = format!("{}/{}", devices_url, claim.device_id);

    // First revoke marks the device revoked but keeps it listed.
    let response = client
        .delete(&revoke_url)
        .bearer_auth(&pairing.daemon_token)
        .send()
        .await
        .expect("revoke request");
    assert!(response.status().is_success());
    let devices =
        get_json::<TrustedDevicesResponse>(&client, &devices_url, Some(&pairing.daemon_token))
            .await;
    assert_eq!(devices.devices.len(), 1);
    assert_eq!(
        devices.devices[0].status,
        falcondeck_core::TrustedDeviceStatus::Revoked
    );

    // Revoking again purges the entry so the UI's "Remove" clears it.
    let response = client
        .delete(&revoke_url)
        .bearer_auth(&pairing.daemon_token)
        .send()
        .await
        .expect("purge request");
    assert!(response.status().is_success());
    let devices =
        get_json::<TrustedDevicesResponse>(&client, &devices_url, Some(&pairing.daemon_token))
            .await;
    assert!(devices.devices.is_empty());
}

#[tokio::test]
async fn a_device_can_revoke_itself_and_is_purged_in_one_call() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;
    let devices_url = format!(
        "{}/v1/sessions/{}/devices",
        server.http_base, claim.session_id
    );

    // A device unpairing on the phone removes its own record entirely: the
    // revoke-then-purge pair is impossible for a client whose token dies with
    // the first revoke.
    let response = client
        .delete(format!("{}/{}", devices_url, claim.device_id))
        .bearer_auth(&claim.client_token)
        .send()
        .await
        .expect("self revoke request");
    assert!(response.status().is_success());

    let devices =
        get_json::<TrustedDevicesResponse>(&client, &devices_url, Some(&pairing.daemon_token))
            .await;
    assert!(devices.devices.is_empty());
}

#[tokio::test]
async fn a_device_cannot_revoke_a_different_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, first_claim) = create_claimed_session(&client, &server.http_base).await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(pairing.session_id.clone()),
            daemon_token: Some(pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &second_pairing.pairing_code,
        Some("tablet"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    let response = client
        .delete(format!(
            "{}/v1/sessions/{}/devices/{}",
            server.http_base, first_claim.session_id, first_claim.device_id
        ))
        .bearer_auth(&second_claim.client_token)
        .send()
        .await
        .expect("cross-device revoke request");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn re_pairing_the_same_client_key_reuses_the_existing_trusted_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let client_key_pair = LocalBoxKeyPair::generate();

    let first_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let first_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &first_pairing.pairing_code,
        Some("Safari on iPhone"),
        &client_key_pair,
    )
    .await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(first_pairing.session_id.clone()),
            daemon_token: Some(first_pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &second_pairing.pairing_code,
        Some("Safari on iPhone"),
        &client_key_pair,
    )
    .await;

    assert_eq!(second_claim.session_id, first_claim.session_id);
    assert_eq!(second_claim.device_id, first_claim.device_id);
    assert_eq!(second_claim.client_token, first_claim.client_token);

    let devices = get_json::<TrustedDevicesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/devices",
            server.http_base, first_claim.session_id
        ),
        Some(&first_pairing.daemon_token),
    )
    .await;
    assert_eq!(devices.devices.len(), 1);
    assert_eq!(devices.devices[0].device_id, first_claim.device_id);
}

#[tokio::test]
async fn reclaiming_the_same_pairing_code_with_the_same_client_key_is_idempotent() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let client_key_pair = LocalBoxKeyPair::generate();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let first_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("Safari on iPhone"),
        &client_key_pair,
    )
    .await;

    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("Safari on iPhone"),
        &client_key_pair,
    )
    .await;

    assert_eq!(second_claim.session_id, first_claim.session_id);
    assert_eq!(second_claim.device_id, first_claim.device_id);
    assert_eq!(second_claim.client_token, first_claim.client_token);
}

#[tokio::test]
async fn query_tokens_are_rejected_and_ws_tickets_are_required() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let http_response = client
        .get(format!(
            "{}/v1/sessions/{}/updates?after_seq=0&token={}",
            server.http_base, claim.session_id, claim.client_token
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(http_response.status(), StatusCode::UNAUTHORIZED);

    let ws_result = connect_async(format!(
        "{}/v1/updates/ws?session_id={}&token={}",
        server.ws_base, claim.session_id, pairing.daemon_token
    ))
    .await;
    assert!(
        ws_result.is_err(),
        "legacy websocket token URL should be rejected"
    );

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    assert!(matches!(
        recv_server_message(&mut daemon_ws).await,
        RelayServerMessage::Ready { .. }
    ));
}

#[tokio::test]
async fn websocket_fanout_and_rpc_forwarding_work() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;

    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();

    let daemon_ready = recv_server_message(&mut daemon_ws).await;
    let remote_ready = recv_server_message(&mut client_ws).await;
    assert!(matches!(daemon_ready, RelayServerMessage::Ready { .. }));
    assert!(matches!(remote_ready, RelayServerMessage::Ready { .. }));

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcRegister {
            method: "approval.respond".to_string(),
        },
    )
    .await;
    let daemon_ack = recv_server_message(&mut daemon_ws).await;
    assert_eq!(
        daemon_ack,
        RelayServerMessage::RpcRegistered {
            method: "approval.respond".to_string(),
        }
    );

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "req-1".to_string(),
            method: "approval.respond".to_string(),
            params: test_envelope("allow"),
        },
    )
    .await;

    // The relay forwards the call under a peer-namespaced request id so
    // identical ids from different devices cannot collide; the daemon
    // echoes whatever id it received.
    let rpc_request = recv_server_message(&mut daemon_ws).await;
    let RelayServerMessage::RpcRequest {
        request_id: forwarded_request_id,
        method,
        params,
    } = rpc_request
    else {
        panic!("expected rpc request, got {rpc_request:?}");
    };
    assert!(
        forwarded_request_id.ends_with(":req-1"),
        "forwarded request id should be namespaced: {forwarded_request_id}"
    );
    assert_eq!(method, "approval.respond");
    assert_eq!(params, test_envelope("allow"));

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcResult {
            request_id: forwarded_request_id,
            ok: true,
            result: Some(test_envelope("ok")),
            error: None,
        },
    )
    .await;

    let rpc_result = recv_server_message(&mut client_ws).await;
    assert_eq!(
        rpc_result,
        RelayServerMessage::RpcResult {
            request_id: "req-1".to_string(),
            ok: true,
            result: Some(test_envelope("ok")),
            error: None,
            failure: None,
        }
    );

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: test_envelope("abc123"),
            },
        },
    )
    .await;

    let update = recv_until_update(&mut client_ws).await;
    assert!(update.seq >= 1);
    assert_eq!(
        update.body,
        RelayUpdateBody::Encrypted {
            envelope: test_envelope("abc123"),
        }
    );

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Sync { after_seq: Some(0) },
    )
    .await;
    let sync = recv_server_message(&mut client_ws).await;
    match sync {
        RelayServerMessage::Sync {
            updates, next_seq, ..
        } => {
            assert!(next_seq >= 2);
            let encrypted_updates = updates
                .iter()
                .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
                .collect::<Vec<_>>();
            assert_eq!(encrypted_updates.len(), 1);
            assert_eq!(
                encrypted_updates[0].body,
                RelayUpdateBody::Encrypted {
                    envelope: test_envelope("abc123"),
                }
            );
        }
        other => panic!("expected sync response, got {other:?}"),
    }

    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    let encrypted_history = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
        .collect::<Vec<_>>();
    assert_eq!(encrypted_history.len(), 1);
    assert!(history.next_seq >= 2);

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "req-2".to_string(),
            method: "missing.method".to_string(),
            params: test_envelope("missing"),
        },
    )
    .await;
    let missing_method = recv_server_message(&mut client_ws).await;
    assert_eq!(
        missing_method,
        RelayServerMessage::RpcResult {
            request_id: "req-2".to_string(),
            ok: false,
            result: None,
            error: None,
            failure: Some(falcondeck_core::RelayRpcFailureCode::MethodUnavailable),
        }
    );
}

#[tokio::test]
async fn overlapping_daemon_rpc_owners_survive_one_peer_disconnect() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let first_daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let second_daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut first_daemon_ws, _) = connect_async(first_daemon_url).await.unwrap();
    let (mut second_daemon_ws, _) = connect_async(second_daemon_url).await.unwrap();
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    assert!(matches!(
        recv_server_message(&mut first_daemon_ws).await,
        RelayServerMessage::Ready { .. }
    ));
    assert!(matches!(
        recv_server_message(&mut second_daemon_ws).await,
        RelayServerMessage::Ready { .. }
    ));
    assert!(matches!(
        recv_server_message(&mut client_ws).await,
        RelayServerMessage::Ready { .. }
    ));

    for daemon in [&mut first_daemon_ws, &mut second_daemon_ws] {
        send_client_message(
            daemon,
            &RelayClientMessage::RpcRegister {
                method: "snapshot.current".to_string(),
            },
        )
        .await;
        assert!(matches!(
            recv_server_message(daemon).await,
            RelayServerMessage::RpcRegistered { .. }
        ));
    }

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "newest-owner".to_string(),
            method: "snapshot.current".to_string(),
            params: test_envelope("snapshot"),
        },
    )
    .await;
    let newest_request = recv_server_message(&mut second_daemon_ws).await;
    let newest_request_id = match newest_request {
        RelayServerMessage::RpcRequest {
            request_id, method, ..
        } => {
            assert_eq!(method, "snapshot.current");
            request_id
        }
        other => panic!("expected newest daemon to receive rpc request, got {other:?}"),
    };
    send_client_message(
        &mut second_daemon_ws,
        &RelayClientMessage::RpcResult {
            request_id: newest_request_id,
            ok: true,
            result: Some(test_envelope("snapshot-result")),
            error: None,
        },
    )
    .await;
    loop {
        if matches!(
            recv_server_message(&mut client_ws).await,
            RelayServerMessage::RpcResult {
                request_id,
                ok: true,
                ..
            } if request_id == "newest-owner"
        ) {
            break;
        }
    }

    let seq_before_disconnect = server
        .state
        .session_updates(&claim.session_id, &claim.client_token, 0)
        .await
        .unwrap()
        .next_seq;
    second_daemon_ws.close(None).await.unwrap();
    timeout(TokioDuration::from_secs(5), async {
        loop {
            let next_seq = server
                .state
                .session_updates(&claim.session_id, &claim.client_token, 0)
                .await
                .unwrap()
                .next_seq;
            if next_seq > seq_before_disconnect {
                break;
            }
            tokio::time::sleep(TokioDuration::from_millis(10)).await;
        }
    })
    .await
    .expect("relay should process the departing daemon peer");

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "surviving-owner".to_string(),
            method: "snapshot.current".to_string(),
            params: test_envelope("detail"),
        },
    )
    .await;
    let request = recv_server_message(&mut first_daemon_ws).await;
    assert!(matches!(
        request,
        RelayServerMessage::RpcRequest { method, .. } if method == "snapshot.current"
    ));
}

#[tokio::test]
async fn expired_pairings_cannot_be_claimed() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: None,
            ttl_seconds: Some(1),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    tokio::time::sleep(TokioDuration::from_millis(1100)).await;

    let challenge_response = client
        .post(format!("{}/v1/pairings/challenge", server.http_base))
        .json(&PairingChallengeRequest {
            pairing_code: pairing.pairing_code.clone(),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(challenge_response.status(), StatusCode::NOT_FOUND);

    let key_pair = LocalBoxKeyPair::generate();
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&signed_claim_request(
            &pairing.pairing_code,
            "expired-challenge",
            None,
            &key_pair,
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn claims_without_a_challenge_are_rejected() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: None,
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    // A valid bundle and a well-formed signature are not enough: no
    // challenge was ever issued for this pairing.
    let key_pair = LocalBoxKeyPair::generate();
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&signed_claim_request(
            &pairing.pairing_code,
            "made-up-challenge",
            Some("attacker"),
            &key_pair,
        ))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let payload = response.json::<serde_json::Value>().await.unwrap();
    assert!(
        payload["error"]
            .as_str()
            .unwrap_or_default()
            .contains("challenge missing or expired"),
        "unexpected error payload: {payload:?}"
    );
}

#[tokio::test]
async fn claims_signed_by_a_different_identity_key_are_rejected() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: None,
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    // A stolen (valid, self-signed) bundle without its secret key: the
    // attacker can only sign the challenge with a different identity key.
    let stolen_bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
    let attacker_identity = LocalIdentityKeyPair::from_box_key_pair(&LocalBoxKeyPair::generate());
    let challenge = request_challenge(&client, &server.http_base, &pairing.pairing_code).await;
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("attacker".to_string()),
            client_bundle: Some(stolen_bundle),
            challenge_signature: sign_pairing_claim_challenge(
                &attacker_identity,
                &pairing.pairing_code,
                &challenge.challenge,
            ),
        })
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn pairing_claim_challenges_are_single_use() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: None,
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let key_pair = LocalBoxKeyPair::generate();
    let challenge = request_challenge(&client, &server.http_base, &pairing.pairing_code).await;
    let request = signed_claim_request(
        &pairing.pairing_code,
        &challenge.challenge,
        Some("phone"),
        &key_pair,
    );

    let first = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);

    // Replaying the identical signed claim must fail: the challenge was
    // consumed by the first claim.
    let replay = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&request)
        .send()
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn stolen_client_bundle_cannot_reattach_as_an_existing_trusted_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let victim_key_pair = LocalBoxKeyPair::generate();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let victim_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("victim phone"),
        &victim_key_pair,
    )
    .await;

    // The relay stores the victim's bundle on the pairing record. An
    // attacker who obtains that stored bundle (relay DB read, backup leak)
    // must not be able to re-claim the pairing and mint the victim device's
    // client token, because they cannot sign the fresh challenge with the
    // victim's identity secret key.
    let stolen_bundle = build_pairing_public_key_bundle(&victim_key_pair);
    let attacker_identity = LocalIdentityKeyPair::from_box_key_pair(&LocalBoxKeyPair::generate());
    let challenge = request_challenge(&client, &server.http_base, &pairing.pairing_code).await;
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("attacker".to_string()),
            client_bundle: Some(stolen_bundle),
            challenge_signature: sign_pairing_claim_challenge(
                &attacker_identity,
                &pairing.pairing_code,
                &challenge.challenge,
            ),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // The victim's trusted device is untouched and remains the only one.
    let devices = get_json::<TrustedDevicesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/devices",
            server.http_base, victim_claim.session_id
        ),
        Some(&pairing.daemon_token),
    )
    .await;
    assert_eq!(devices.devices.len(), 1);
    assert_eq!(devices.devices[0].device_id, victim_claim.device_id);

    // The legitimate holder of the identity secret key can still re-claim.
    let reclaim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("victim phone"),
        &victim_key_pair,
    )
    .await;
    assert_eq!(reclaim.device_id, victim_claim.device_id);
    assert_eq!(reclaim.client_token, victim_claim.client_token);
}

#[tokio::test]
async fn forged_bundle_with_victim_box_key_cannot_reattach_as_the_victim_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let victim_key_pair = LocalBoxKeyPair::generate();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let victim_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("victim phone"),
        &victim_key_pair,
    )
    .await;

    // A bundle's self-signature only binds it to the identity key inside
    // the bundle itself, so an attacker holding the pairing code and the
    // victim's *published* box public key can mint a validly signed bundle
    // pairing that box key with their own identity key — and sign the
    // fresh challenge with that identity key so the claim proof passes.
    // The relay must still refuse to hand out the victim device's token.
    let attacker_identity = LocalIdentityKeyPair::from_box_key_pair(&LocalBoxKeyPair::generate());
    let forged_bundle = forged_bundle_for(&victim_key_pair, &attacker_identity);
    let challenge = request_challenge(&client, &server.http_base, &pairing.pairing_code).await;
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&ClaimPairingRequest {
            pairing_code: pairing.pairing_code.clone(),
            label: Some("attacker".to_string()),
            client_bundle: Some(forged_bundle),
            challenge_signature: sign_pairing_claim_challenge(
                &attacker_identity,
                &pairing.pairing_code,
                &challenge.challenge,
            ),
        })
        .send()
        .await
        .unwrap();
    if response.status() == StatusCode::OK {
        let attacker_claim = response.json::<ClaimPairingResponse>().await.unwrap();
        assert_ne!(attacker_claim.device_id, victim_claim.device_id);
        assert_ne!(attacker_claim.client_token, victim_claim.client_token);
    } else {
        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    // The victim's trusted device is untouched.
    let devices = get_json::<TrustedDevicesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/devices",
            server.http_base, victim_claim.session_id
        ),
        Some(&pairing.daemon_token),
    )
    .await;
    let victim_device = devices
        .devices
        .iter()
        .find(|device| device.device_id == victim_claim.device_id)
        .expect("victim device should still exist");
    assert_eq!(
        victim_device.status,
        falcondeck_core::TrustedDeviceStatus::Active
    );

    // The victim can still re-claim with the real identity secret key.
    let reclaim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("victim phone"),
        &victim_key_pair,
    )
    .await;
    assert_eq!(reclaim.device_id, victim_claim.device_id);
    assert_eq!(reclaim.client_token, victim_claim.client_token);
}

#[tokio::test]
async fn revoked_devices_cannot_reclaim_a_dead_client_token() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let key_pair = LocalBoxKeyPair::generate();

    let pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let claim = claim_with_challenge(
        &client,
        &server.http_base,
        &pairing.pairing_code,
        Some("phone"),
        &key_pair,
    )
    .await;

    let revoked = client
        .delete(format!(
            "{}/v1/sessions/{}/devices/{}",
            server.http_base, claim.session_id, claim.device_id
        ))
        .bearer_auth(&pairing.daemon_token)
        .send()
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::OK);

    // Re-claiming the same pairing code must not "succeed" with the
    // revoked device's client token, which authenticate_session would then
    // reject anyway; the claim falls through to the conflict handling.
    let challenge = request_challenge(&client, &server.http_base, &pairing.pairing_code).await;
    let response = client
        .post(format!("{}/v1/pairings/claim", server.http_base))
        .json(&signed_claim_request(
            &pairing.pairing_code,
            &challenge.challenge,
            Some("phone"),
            &key_pair,
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn queued_actions_are_not_redispatched_while_the_daemon_is_still_connected() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let first_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-1".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("payload-1"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: first_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(first_request.action_id, first_action.action_id);

    let second_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-2".to_string(),
            action_type: "thread.update".to_string(),
            payload: test_envelope("payload-2"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: second_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(second_request.action_id, second_action.action_id);

    let unexpected = timeout(
        TokioDuration::from_millis(250),
        recv_until_action_requested(&mut daemon_ws),
    )
    .await;
    assert!(
        unexpected.is_err(),
        "first queued action was redispatched unexpectedly"
    );
}

#[tokio::test]
async fn dispatched_actions_are_requeued_after_daemon_disconnect() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(&daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-requeue".to_string(),
            action_type: "turn.start".to_string(),
            payload: test_envelope("payload-requeue"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: initial_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(initial_request.action_id, action.action_id);

    daemon_ws.close(None).await.unwrap();

    let reconnect_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut reconnected_ws, _) = connect_async(reconnect_url).await.unwrap();
    let _ = recv_server_message(&mut reconnected_ws).await;
    let RelayServerMessage::ActionRequested {
        action: retried_request,
        ..
    } = recv_until_action_requested(&mut reconnected_ws).await
    else {
        unreachable!();
    };
    assert_eq!(retried_request.action_id, action.action_id);
}

#[tokio::test]
async fn executing_actions_are_requeued_after_daemon_disconnect() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(&daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "idempotency-executing-requeue".to_string(),
            action_type: "turn.start".to_string(),
            payload: test_envelope("payload-executing-requeue"),
        },
        Some(&claim.client_token),
    )
    .await;
    let RelayServerMessage::ActionRequested {
        action: initial_request,
        ..
    } = recv_until_action_requested(&mut daemon_ws).await
    else {
        unreachable!();
    };
    assert_eq!(initial_request.action_id, action.action_id);

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::ActionUpdate {
            action_id: action.action_id.clone(),
            status: falcondeck_core::QueuedRemoteActionStatus::Executing,
            error: None,
            result: None,
        },
    )
    .await;

    daemon_ws.close(None).await.unwrap();

    let reconnect_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut reconnected_ws, _) = connect_async(reconnect_url).await.unwrap();
    let _ = recv_server_message(&mut reconnected_ws).await;
    let RelayServerMessage::ActionRequested {
        action: retried_request,
        ..
    } = recv_until_action_requested(&mut reconnected_ws).await
    else {
        unreachable!();
    };
    assert_eq!(retried_request.action_id, action.action_id);
}

#[tokio::test]
async fn persisted_updates_survive_restart() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");

    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;
    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: test_envelope("persist-me"),
            },
        },
    )
    .await;
    let _ = recv_until_update(&mut daemon_ws).await;
    tokio::time::sleep(TokioDuration::from_millis(250)).await;

    server.task.abort();
    let _keep_tempdir = temp_dir;

    let restarted = spawn_server_at(state_path).await;
    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            restarted.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    let encrypted_updates = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
        .collect::<Vec<_>>();
    assert_eq!(encrypted_updates.len(), 1);
    assert_eq!(
        encrypted_updates[0].body,
        RelayUpdateBody::Encrypted {
            envelope: test_envelope("persist-me"),
        }
    );
}

#[tokio::test]
async fn pruned_history_sets_truncation_cursor_without_reusing_sequences() {
    let server = spawn_server_with_retention(RetentionConfig {
        update_retention: Duration::days(7),
        max_updates_per_session: 1,
        trusted_device_retention: Duration::days(180),
        claimed_pairing_retention: Duration::days(1),
        completed_action_retention: Duration::days(3),
    })
    .await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    for marker in ["one", "two", "three"] {
        send_client_message(
            &mut daemon_ws,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: test_envelope(marker),
                },
            },
        )
        .await;
        let _ = recv_until_update(&mut daemon_ws).await;
    }

    // Pruning runs in the background; the health endpoint keeps a
    // synchronous trigger so tests can force a pass deterministically.
    trigger_prune(&server).await;

    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=1",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;

    assert!(history.cursor.history_truncated);
    assert_eq!(history.next_seq, 5);
    assert_eq!(history.updates.len(), 1);
    assert_eq!(history.updates[0].seq, 4);
}

#[tokio::test]
async fn truncated_websocket_replay_yields_to_snapshot_recovery() {
    let server = spawn_server_with_retention(RetentionConfig {
        update_retention: Duration::days(7),
        max_updates_per_session: 1,
        trusted_device_retention: Duration::days(180),
        claimed_pairing_retention: Duration::days(1),
        completed_action_retention: Duration::days(3),
    })
    .await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    for marker in ["one", "two", "three"] {
        send_client_message(
            &mut daemon_ws,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: test_envelope(marker),
                },
            },
        )
        .await;
        let _ = recv_until_update(&mut daemon_ws).await;
    }

    trigger_prune(&server).await;

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcRegister {
            method: "snapshot.current".to_string(),
        },
    )
    .await;
    assert_eq!(
        recv_server_message(&mut daemon_ws).await,
        RelayServerMessage::RpcRegistered {
            method: "snapshot.current".to_string(),
        }
    );

    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    assert!(matches!(
        recv_server_message(&mut client_ws).await,
        RelayServerMessage::Ready { .. }
    ));

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Sync { after_seq: Some(0) },
    )
    .await;

    let RelayServerMessage::Sync {
        updates,
        next_seq,
        history_truncated,
    } = recv_server_message(&mut client_ws).await
    else {
        panic!("expected truncated sync response");
    };

    // A retained tail is not useful after a gap: clients must replace their
    // derived state from snapshot.current. Replaying it here previously
    // filled the bounded outbound queue, disconnected iOS, and trapped it in
    // an endless reconnect / "Syncing your projects" loop.
    assert!(history_truncated);
    assert!(updates.is_empty());
    assert!(next_seq >= 5);

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "snapshot-after-truncation".to_string(),
            method: "snapshot.current".to_string(),
            params: test_envelope("snapshot-request"),
        },
    )
    .await;

    let RelayServerMessage::RpcRequest {
        request_id, method, ..
    } = recv_server_message(&mut daemon_ws).await
    else {
        panic!("expected snapshot RPC after truncated sync");
    };
    assert!(request_id.ends_with(":snapshot-after-truncation"));
    assert_eq!(method, "snapshot.current");
}

#[tokio::test]
async fn client_peers_cannot_append_durable_updates() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (_pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    let _ = recv_server_message(&mut client_ws).await;

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: test_envelope("forged-by-client"),
            },
        },
    )
    .await;

    let response = recv_server_message(&mut client_ws).await;
    assert!(
        matches!(response, RelayServerMessage::Error { .. }),
        "expected error message, got {response:?}"
    );

    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    assert!(
        history
            .updates
            .iter()
            .all(|update| !matches!(update.body, RelayUpdateBody::Encrypted { .. })),
        "client-forged update must not be appended to the replay log"
    );
}

#[tokio::test]
async fn push_token_registration_requires_matching_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (_pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let own = client
        .post(format!(
            "{}/v1/sessions/{}/devices/{}/push-token",
            server.http_base, claim.session_id, claim.device_id
        ))
        .bearer_auth(&claim.client_token)
        .json(&serde_json::json!({ "push_token": "ExponentPushToken[test-token]" }))
        .send()
        .await
        .unwrap();
    assert_eq!(own.status(), StatusCode::OK);

    // Clearing the token is allowed too.
    let cleared = client
        .post(format!(
            "{}/v1/sessions/{}/devices/{}/push-token",
            server.http_base, claim.session_id, claim.device_id
        ))
        .bearer_auth(&claim.client_token)
        .json(&serde_json::json!({ "push_token": null }))
        .send()
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::OK);

    // A client may not register a token for a different device.
    let other = client
        .post(format!(
            "{}/v1/sessions/{}/devices/{}/push-token",
            server.http_base, claim.session_id, "device-other"
        ))
        .bearer_auth(&claim.client_token)
        .json(&serde_json::json!({ "push_token": "ExponentPushToken[stolen]" }))
        .send()
        .await
        .unwrap();
    assert_eq!(other.status(), StatusCode::UNAUTHORIZED);

    // Unknown devices are rejected even for the daemon token.
    let unknown = client
        .post(format!(
            "{}/v1/sessions/{}/devices/{}/push-token",
            server.http_base, claim.session_id, "device-missing"
        ))
        .bearer_auth(&_pairing.daemon_token)
        .json(&serde_json::json!({ "push_token": "ExponentPushToken[na]" }))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn client_peers_cannot_request_push_notifications() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (_pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    let _ = recv_server_message(&mut client_ws).await;

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::Notify {
            kind: "approval".to_string(),
            workspace_id: None,
            thread_id: None,
        },
    )
    .await;

    let response = recv_server_message(&mut client_ws).await;
    assert!(
        matches!(response, RelayServerMessage::Error { .. }),
        "expected error message, got {response:?}"
    );
}

#[tokio::test]
async fn idle_trusted_sessions_are_pruned_after_retention_expires() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (_pairing, claim) = create_claimed_session(&client, &server.http_base).await;
    server.task.abort();

    let restarted = spawn_server_at_with_retention(
        state_path,
        RetentionConfig {
            update_retention: Duration::milliseconds(5),
            max_updates_per_session: 10_000,
            trusted_device_retention: Duration::milliseconds(5),
            claimed_pairing_retention: Duration::milliseconds(5),
            completed_action_retention: Duration::milliseconds(5),
        },
    )
    .await;

    tokio::time::sleep(TokioDuration::from_millis(20)).await;
    trigger_prune(&restarted).await;

    let response = client
        .get(format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            restarted.http_base, claim.session_id
        ))
        .header("authorization", format!("Bearer {}", claim.client_token))
        .send()
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn persisted_inflight_actions_are_requeued_on_restart() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");

    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(&daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let dispatched = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "restart-dispatched".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("restart-dispatched"),
        },
        Some(&claim.client_token),
    )
    .await;
    let executing = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "restart-executing".to_string(),
            action_type: "turn.start".to_string(),
            payload: test_envelope("restart-executing"),
        },
        Some(&claim.client_token),
    )
    .await;
    let first_request = recv_until_action_requested(&mut daemon_ws).await;
    let second_request = recv_until_action_requested(&mut daemon_ws).await;
    let executing_action_id = match (&first_request, &second_request) {
        (
            RelayServerMessage::ActionRequested { action, .. },
            RelayServerMessage::ActionRequested { action: other, .. },
        ) if action.action_id == executing.action_id || other.action_id == executing.action_id => {
            executing.action_id.clone()
        }
        _ => unreachable!(),
    };

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::ActionUpdate {
            action_id: executing_action_id,
            status: falcondeck_core::QueuedRemoteActionStatus::Executing,
            error: None,
            result: None,
        },
    )
    .await;
    tokio::time::sleep(TokioDuration::from_millis(250)).await;

    server.task.abort();
    let restarted = spawn_server_at(state_path).await;
    let restarted_daemon_url = ws_url_for(
        &client,
        &restarted.http_base,
        &restarted.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut restarted_ws, _) = connect_async(restarted_daemon_url).await.unwrap();
    let _ = recv_server_message(&mut restarted_ws).await;

    let mut action_ids = Vec::new();
    for _ in 0..2 {
        let RelayServerMessage::ActionRequested { action, .. } =
            recv_until_action_requested(&mut restarted_ws).await
        else {
            unreachable!();
        };
        action_ids.push(action.action_id);
    }
    assert!(action_ids.contains(&dispatched.action_id));
    assert!(action_ids.contains(&executing.action_id));
}

#[tokio::test]
async fn persisted_state_does_not_store_plaintext_session_markers() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let server = spawn_server_at(state_path.clone()).await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;

    let data_key = generate_data_key();
    let marker = "TOP_SECRET_FALCONDECK_MARKER";
    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::Update {
            body: RelayUpdateBody::Encrypted {
                envelope: encrypt_json(&data_key, &serde_json::json!({ "marker": marker }))
                    .unwrap(),
            },
        },
    )
    .await;
    let _ = recv_until_update(&mut daemon_ws).await;

    let persisted = std::fs::read_to_string(state_path).unwrap();
    assert!(
        !persisted.contains(marker),
        "relay state should not contain plaintext session payloads"
    );
}

#[tokio::test]
async fn bursty_updates_are_streamed_without_waiting_for_file_persistence() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;
    let _ = recv_server_message(&mut client_ws).await;

    for index in 0..100 {
        send_client_message(
            &mut daemon_ws,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: test_envelope(&format!("burst-{index}")),
                },
            },
        )
        .await;
    }

    let received = timeout(TokioDuration::from_secs(2), async {
        let mut count = 0;
        while count < 100 {
            let _ = recv_until_update(&mut client_ws).await;
            count += 1;
        }
        count
    })
    .await
    .unwrap();
    assert_eq!(received, 100);
}

#[tokio::test]
async fn duplicate_daemon_peers_cannot_complete_non_owned_actions() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_a, _) = connect_async(&daemon_url).await.unwrap();
    let daemon_b_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let (mut daemon_b, _) = connect_async(&daemon_b_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_a).await;
    let _ = recv_server_message(&mut daemon_b).await;

    let action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "duplicate-daemon-owner".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("duplicate-daemon-owner"),
        },
        Some(&claim.client_token),
    )
    .await;

    let first_owner_message = tokio::time::timeout(
        TokioDuration::from_millis(250),
        recv_until_action_requested(&mut daemon_a),
    )
    .await;
    let (owner, stale, owner_action) =
        if let Ok(RelayServerMessage::ActionRequested { action, .. }) = first_owner_message {
            (&mut daemon_a, &mut daemon_b, action)
        } else {
            let RelayServerMessage::ActionRequested { action, .. } =
                recv_until_action_requested(&mut daemon_b).await
            else {
                unreachable!();
            };
            (&mut daemon_b, &mut daemon_a, action)
        };
    assert_eq!(owner_action.action_id, action.action_id);

    send_client_message(
        stale,
        &RelayClientMessage::ActionUpdate {
            action_id: action.action_id.clone(),
            status: falcondeck_core::QueuedRemoteActionStatus::Completed,
            error: None,
            result: Some(test_envelope("stale-result")),
        },
    )
    .await;

    let current = get_json::<falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions/{}",
            server.http_base, claim.session_id, action.action_id
        ),
        Some(&claim.client_token),
    )
    .await;
    assert_ne!(
        current.status,
        falcondeck_core::QueuedRemoteActionStatus::Completed
    );

    send_client_message(
        owner,
        &RelayClientMessage::ActionUpdate {
            action_id: action.action_id.clone(),
            status: falcondeck_core::QueuedRemoteActionStatus::Completed,
            error: None,
            result: Some(test_envelope("owner-result")),
        },
    )
    .await;

    let completed = get_json::<falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions/{}",
            server.http_base, claim.session_id, action.action_id
        ),
        Some(&claim.client_token),
    )
    .await;
    assert_eq!(
        completed.status,
        falcondeck_core::QueuedRemoteActionStatus::Completed
    );
}

#[tokio::test]
async fn queued_action_idempotency_is_scoped_per_device() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, first_claim) = create_claimed_session(&client, &server.http_base).await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("tablet".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(pairing.session_id.clone()),
            daemon_token: Some(pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &second_pairing.pairing_code,
        Some("tablet"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    let first_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, first_claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "shared-idempotency".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("first-device"),
        },
        Some(&first_claim.client_token),
    )
    .await;
    let second_action = post_json::<_, falcondeck_core::QueuedRemoteAction>(
        &client,
        &format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, second_claim.session_id
        ),
        &SubmitQueuedActionRequest {
            idempotency_key: "shared-idempotency".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("second-device"),
        },
        Some(&second_claim.client_token),
    )
    .await;
    assert_ne!(first_action.action_id, second_action.action_id);

    let conflict = client
        .post(format!(
            "{}/v1/sessions/{}/actions",
            server.http_base, first_claim.session_id
        ))
        .bearer_auth(&first_claim.client_token)
        .json(&SubmitQueuedActionRequest {
            idempotency_key: "shared-idempotency".to_string(),
            action_type: "thread.start".to_string(),
            payload: test_envelope("first-device-mismatch"),
        })
        .send()
        .await
        .unwrap();
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn legacy_state_recovers_sessions_and_skips_incompatible_pairings() {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    // Timestamps are generated relative to now; hardcoded dates eventually
    // age past the retention window and the recovered session gets pruned.
    let created_at = (chrono::Utc::now() - Duration::minutes(10)).to_rfc3339();
    let expires_at = (chrono::Utc::now() - Duration::minutes(5)).to_rfc3339();
    let updated_at = (chrono::Utc::now() - Duration::minutes(5)).to_rfc3339();
    std::fs::write(
        &state_path,
        format!(
            r#"{{
  "pairings": {{
    "pairing-old": {{
      "pairing_id": "pairing-old",
      "pairing_code": "ABC12345",
      "daemon_token": "daemon-old",
      "label": "legacy",
      "session_id": "session-old",
      "daemon_bundle": {{"daemonVersion":"0.1.0"}},
      "client_bundle": null,
      "created_at": "{created_at}",
      "expires_at": "{expires_at}"
    }}
  }},
  "sessions": {{
    "session-old": {{
      "session_id": "session-old",
      "pairing_id": "pairing-old",
      "daemon_token": "daemon-old",
      "client_token": "client-old",
      "created_at": "{created_at}",
      "updated_at": "{updated_at}",
      "updates": [{{
        "id":"update-old",
        "seq":1,
        "body":{{"kind":"daemon-event","event":{{"seq":0}}}},
        "created_at":"{updated_at}"
      }}]
    }}
  }}
}}"#
        ),
    )
    .unwrap();

    let state = AppState::load("test".to_string(), state_path, Duration::seconds(300))
        .await
        .unwrap();
    let health = state.health().await;
    // Pairing is skipped (incompatible daemon_bundle format), but the
    // session is recovered with its incompatible updates cleared.
    assert_eq!(health.pending_pairings, 0);
    assert_eq!(health.active_sessions, 1);
}

#[tokio::test]
async fn presence_updates_supersede_older_presence_history() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    // Each connect/disconnect cycle appends durable presence updates; only
    // the newest snapshot may stay in the replay log.
    for marker in ["one", "two"] {
        let daemon_url = ws_url_for(
            &client,
            &server.http_base,
            &server.ws_base,
            &claim.session_id,
            &pairing.daemon_token,
        )
        .await;
        let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
        let _ = recv_server_message(&mut daemon_ws).await;
        send_client_message(
            &mut daemon_ws,
            &RelayClientMessage::Update {
                body: RelayUpdateBody::Encrypted {
                    envelope: test_envelope(marker),
                },
            },
        )
        .await;
        let _ = recv_until_update(&mut daemon_ws).await;
        daemon_ws.close(None).await.unwrap();
        // Give the relay time to notice the disconnect and append the
        // corresponding presence update.
        tokio::time::sleep(TokioDuration::from_millis(100)).await;
    }

    let history = get_json::<RelayUpdatesResponse>(
        &client,
        &format!(
            "{}/v1/sessions/{}/updates?after_seq=0",
            server.http_base, claim.session_id
        ),
        Some(&claim.client_token),
    )
    .await;
    let presence_count = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Presence { .. }))
        .count();
    let encrypted_count = history
        .updates
        .iter()
        .filter(|update| matches!(update.body, RelayUpdateBody::Encrypted { .. }))
        .count();
    assert_eq!(
        presence_count, 1,
        "only the latest presence update should be retained"
    );
    assert_eq!(
        encrypted_count, 2,
        "encrypted updates must survive presence churn"
    );
    // Superseding presence rows removes the oldest retained update, but
    // nothing a client needs was lost — it must not report truncation.
    assert!(
        !history.cursor.history_truncated,
        "presence supersede must not flag history as truncated"
    );
}

#[tokio::test]
async fn oversized_rpc_request_ids_are_rejected() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (_pairing, claim) = create_claimed_session(&client, &server.http_base).await;

    let client_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &claim.session_id,
        &claim.client_token,
    )
    .await;
    let (mut client_ws, _) = connect_async(client_url).await.unwrap();
    let _ = recv_server_message(&mut client_ws).await;

    send_client_message(
        &mut client_ws,
        &RelayClientMessage::RpcCall {
            request_id: "r".repeat(129),
            method: "approval.respond".to_string(),
            params: test_envelope("oversized"),
        },
    )
    .await;

    let response = recv_server_message(&mut client_ws).await;
    assert!(
        matches!(response, RelayServerMessage::Error { .. }),
        "expected error message, got {response:?}"
    );
}

#[tokio::test]
async fn duplicate_request_ids_from_different_devices_do_not_collide() {
    let server = spawn_server().await;
    let client = reqwest::Client::new();
    let (pairing, first_claim) = create_claimed_session(&client, &server.http_base).await;

    let second_pairing = post_json::<_, StartPairingResponse>(
        &client,
        &format!("{}/v1/pairings", server.http_base),
        &StartPairingRequest {
            label: Some("tablet".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: Some(pairing.session_id.clone()),
            daemon_token: Some(pairing.daemon_token.clone()),
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;
    let second_claim = claim_with_challenge(
        &client,
        &server.http_base,
        &second_pairing.pairing_code,
        Some("tablet"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    let daemon_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &first_claim.session_id,
        &pairing.daemon_token,
    )
    .await;
    let first_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &first_claim.session_id,
        &first_claim.client_token,
    )
    .await;
    let second_url = ws_url_for(
        &client,
        &server.http_base,
        &server.ws_base,
        &second_claim.session_id,
        &second_claim.client_token,
    )
    .await;
    let (mut daemon_ws, _) = connect_async(daemon_url).await.unwrap();
    let (mut first_ws, _) = connect_async(first_url).await.unwrap();
    let (mut second_ws, _) = connect_async(second_url).await.unwrap();
    let _ = recv_server_message(&mut daemon_ws).await;
    let _ = recv_server_message(&mut first_ws).await;
    let _ = recv_server_message(&mut second_ws).await;

    send_client_message(
        &mut daemon_ws,
        &RelayClientMessage::RpcRegister {
            method: "thread.detail".to_string(),
        },
    )
    .await;
    let ack = recv_server_message(&mut daemon_ws).await;
    assert!(matches!(ack, RelayServerMessage::RpcRegistered { .. }));

    // Both devices use the same client-chosen request id, as fresh
    // per-device counters naturally produce.
    send_client_message(
        &mut first_ws,
        &RelayClientMessage::RpcCall {
            request_id: "mobile-detail-0".to_string(),
            method: "thread.detail".to_string(),
            params: test_envelope("first-params"),
        },
    )
    .await;
    send_client_message(
        &mut second_ws,
        &RelayClientMessage::RpcCall {
            request_id: "mobile-detail-0".to_string(),
            method: "thread.detail".to_string(),
            params: test_envelope("second-params"),
        },
    )
    .await;

    // The daemon sees two distinct namespaced ids and answers each call
    // with a result tied to that call's params.
    for _ in 0..2 {
        let message = recv_server_message(&mut daemon_ws).await;
        let RelayServerMessage::RpcRequest {
            request_id, params, ..
        } = message
        else {
            panic!("expected rpc request, got {message:?}");
        };
        let marker = if params == test_envelope("first-params") {
            "first-result"
        } else {
            "second-result"
        };
        send_client_message(
            &mut daemon_ws,
            &RelayClientMessage::RpcResult {
                request_id,
                ok: true,
                result: Some(test_envelope(marker)),
                error: None,
            },
        )
        .await;
    }

    // Each device receives its own result under its own request id.
    let first_result = recv_server_message(&mut first_ws).await;
    assert_eq!(
        first_result,
        RelayServerMessage::RpcResult {
            request_id: "mobile-detail-0".to_string(),
            ok: true,
            result: Some(test_envelope("first-result")),
            error: None,
            failure: None,
        }
    );
    let second_result = recv_server_message(&mut second_ws).await;
    assert_eq!(
        second_result,
        RelayServerMessage::RpcResult {
            request_id: "mobile-detail-0".to_string(),
            ok: true,
            result: Some(test_envelope("second-result")),
            error: None,
            failure: None,
        }
    );
}

async fn create_claimed_session(
    client: &reqwest::Client,
    http_base: &str,
) -> (StartPairingResponse, ClaimPairingResponse) {
    let pairing = post_json::<_, StartPairingResponse>(
        client,
        &format!("{http_base}/v1/pairings"),
        &StartPairingRequest {
            label: Some("desktop".to_string()),
            ttl_seconds: Some(300),
            existing_session_id: None,
            daemon_token: None,
            daemon_bundle: Some(test_bundle()),
        },
        None,
    )
    .await;

    let claim = claim_with_challenge(
        client,
        http_base,
        &pairing.pairing_code,
        Some("remote-web"),
        &LocalBoxKeyPair::generate(),
    )
    .await;

    (pairing, claim)
}

/// Requests a fresh single-use challenge for the pairing code.
async fn request_challenge(
    client: &reqwest::Client,
    http_base: &str,
    pairing_code: &str,
) -> PairingChallengeResponse {
    post_json::<_, PairingChallengeResponse>(
        client,
        &format!("{http_base}/v1/pairings/challenge"),
        &PairingChallengeRequest {
            pairing_code: pairing_code.to_string(),
        },
        None,
    )
    .await
}

/// Builds a claim request whose challenge signature proves possession of the
/// key pair's identity secret key, mirroring what real clients do.
fn signed_claim_request(
    pairing_code: &str,
    challenge: &str,
    label: Option<&str>,
    key_pair: &LocalBoxKeyPair,
) -> ClaimPairingRequest {
    let identity = LocalIdentityKeyPair::from_box_key_pair(key_pair);
    ClaimPairingRequest {
        pairing_code: pairing_code.to_string(),
        label: label.map(str::to_string),
        client_bundle: Some(build_pairing_public_key_bundle(key_pair)),
        challenge_signature: sign_pairing_claim_challenge(&identity, pairing_code, challenge),
    }
}

/// Full challenge → sign → claim flow with the given client key pair.
async fn claim_with_challenge(
    client: &reqwest::Client,
    http_base: &str,
    pairing_code: &str,
    label: Option<&str>,
    key_pair: &LocalBoxKeyPair,
) -> ClaimPairingResponse {
    let challenge = request_challenge(client, http_base, pairing_code).await;
    post_json::<_, ClaimPairingResponse>(
        client,
        &format!("{http_base}/v1/pairings/claim"),
        &signed_claim_request(pairing_code, &challenge.challenge, label, key_pair),
        None,
    )
    .await
}

async fn post_json<T, R>(client: &reqwest::Client, url: &str, body: &T, bearer: Option<&str>) -> R
where
    T: serde::Serialize + ?Sized,
    R: DeserializeOwned,
{
    let request = client.post(url).json(body);
    let request = if let Some(token) = bearer {
        request.bearer_auth(token)
    } else {
        request
    };

    request
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<R>()
        .await
        .unwrap()
}

/// Force a synchronous prune pass; retention otherwise runs only on the
/// relay's background interval.
async fn trigger_prune(server: &TestServer) {
    server.state.force_prune().await.unwrap();
}

async fn get_json<R>(client: &reqwest::Client, url: &str, bearer: Option<&str>) -> R
where
    R: DeserializeOwned,
{
    let request = client.get(url);
    let request = if let Some(token) = bearer {
        request.bearer_auth(token)
    } else {
        request
    };

    request
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<R>()
        .await
        .unwrap()
}

async fn send_client_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    message: &RelayClientMessage,
) {
    let payload = serde_json::to_string(message).unwrap();
    socket.send(Message::Text(payload.into())).await.unwrap();
}

async fn ws_url_for(
    client: &reqwest::Client,
    http_base: &str,
    ws_base: &str,
    session_id: &str,
    bearer: &str,
) -> String {
    let ticket = client
        .post(format!("{http_base}/v1/sessions/{session_id}/ws-ticket"))
        .bearer_auth(bearer)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json::<RelayWebSocketTicketResponse>()
        .await
        .unwrap();
    format!(
        "{ws_base}/v1/updates/ws?session_id={}&ticket={}",
        session_id, ticket.ticket
    )
}

async fn recv_server_message(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> RelayServerMessage {
    loop {
        let message = timeout(TokioDuration::from_secs(5), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Message::Text(text) = message else {
            panic!("expected text websocket frame");
        };
        let parsed = serde_json::from_str::<RelayServerMessage>(&text).unwrap();
        match parsed {
            RelayServerMessage::Presence { .. } | RelayServerMessage::ActionUpdated { .. } => {}
            RelayServerMessage::Update { ref update }
                if matches!(
                    update.body,
                    RelayUpdateBody::Presence { .. } | RelayUpdateBody::ActionStatus { .. }
                ) => {}
            other => return other,
        }
    }
}

async fn recv_until_action_requested(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> falcondeck_core::RelayServerMessage {
    loop {
        match recv_server_message(socket).await {
            message @ RelayServerMessage::ActionRequested { .. } => return message,
            RelayServerMessage::Pong
            | RelayServerMessage::RpcRegistered { .. }
            | RelayServerMessage::RpcUnregistered { .. }
            | RelayServerMessage::RpcResult { .. }
            | RelayServerMessage::Update { .. } => {}
            other => panic!("expected action request, got {other:?}"),
        }
    }
}

async fn recv_until_update(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> RelayUpdate {
    loop {
        match recv_server_message(socket).await {
            RelayServerMessage::Update { update } => return update,
            RelayServerMessage::Pong => {}
            RelayServerMessage::RpcResult { .. } => {}
            RelayServerMessage::Presence { .. } => {}
            other => panic!("expected update message, got {other:?}"),
        }
    }
}

async fn spawn_server() -> TestServer {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let mut server = spawn_server_at(state_path).await;
    server.temp_dir = Some(temp_dir);
    server
}

async fn spawn_server_at(state_path: PathBuf) -> TestServer {
    spawn_server_at_with_retention(state_path, RetentionConfig::default()).await
}

async fn spawn_server_with_retention(retention: RetentionConfig) -> TestServer {
    let temp_dir = tempfile::tempdir().unwrap();
    let state_path = temp_dir.path().join("relay-state.json");
    let mut server = spawn_server_at_with_retention(state_path, retention).await;
    server.temp_dir = Some(temp_dir);
    server
}

async fn spawn_server_at_with_retention(
    state_path: PathBuf,
    retention: RetentionConfig,
) -> TestServer {
    let state = AppState::load_with_retention(
        "test".to_string(),
        PathBuf::from(&state_path),
        Duration::seconds(300),
        retention,
    )
    .await
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router_state = state.clone();
    let task = tokio::spawn(async move {
        axum::serve(listener, router(router_state)).await.unwrap();
    });

    TestServer {
        temp_dir: None,
        task,
        http_base: format!("http://{}", format_addr(addr)),
        ws_base: format!("ws://{}", format_addr(addr)),
        state,
    }
}

fn format_addr(addr: SocketAddr) -> String {
    match addr {
        SocketAddr::V4(_) => addr.to_string(),
        SocketAddr::V6(_) => format!("[{}]:{}", addr.ip(), addr.port()),
    }
}

fn test_bundle() -> PairingPublicKeyBundle {
    let key_pair = LocalBoxKeyPair::generate();
    build_pairing_public_key_bundle(&key_pair)
}

/// Builds a validly self-signed bundle that pairs the given box public key
/// with an unrelated identity key — the forgery an attacker can mint from a
/// victim's published box public key alone.
fn forged_bundle_for(
    box_key_pair: &LocalBoxKeyPair,
    identity: &LocalIdentityKeyPair,
) -> PairingPublicKeyBundle {
    let mut bundle = PairingPublicKeyBundle {
        encryption_variant: EncryptionVariant::DataKeyV1,
        identity_variant: IdentityVariant::Ed25519V1,
        public_key: box_key_pair.public_key_base64().to_string(),
        identity_public_key: identity.public_key_base64().to_string(),
        signature: String::new(),
    };
    // Mirrors `pairing_bundle_signing_payload` in falcondeck-core.
    let payload = format!(
        "falcondeck-pairing-bundle-v1\ndata_key_v1\ned25519_v1\n{}\n{}",
        bundle.public_key, bundle.identity_public_key
    );
    bundle.signature = identity.sign_bytes(payload.as_bytes());
    bundle
}

fn test_envelope(marker: &str) -> EncryptedEnvelope {
    EncryptedEnvelope {
        encryption_variant: EncryptionVariant::DataKeyV1,
        ciphertext: format!("opaque-{marker}"),
    }
}
