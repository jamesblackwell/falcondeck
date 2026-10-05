//! Per-Codex-runtime OAuth transport. The harness holds only a local
//! capability; the daemon refreshes provider credentials for every request.

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::any,
};
use tokio::{net::TcpListener, task::JoinHandle};

use crate::{
    app::AppState,
    connector_oauth,
    connectors::{McpServerConfig, McpTransport},
    error::DaemonError,
};

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

struct Target {
    name: String,
    url: String,
    headers: std::collections::BTreeMap<String, String>,
}

struct ProxyState {
    app: AppState,
    workspace_id: String,
    authorization: String,
    targets: Vec<Target>,
    client: reqwest::Client,
}

pub(crate) struct ConnectorProxy {
    task: JoinHandle<()>,
}

impl Drop for ConnectorProxy {
    fn drop(&mut self) {
        self.stop();
    }
}

impl ConnectorProxy {
    pub(crate) fn stop(&self) {
        self.task.abort();
    }

    pub(crate) async fn start(
        app: AppState,
        workspace_id: &str,
        oauth_names: &BTreeSet<String>,
        servers: &mut [McpServerConfig],
    ) -> Result<Option<Self>, DaemonError> {
        let mut targets = Vec::new();
        for server in servers.iter() {
            if oauth_names.contains(&server.name)
                && let McpTransport::Http { url, headers } = &server.transport
            {
                targets.push(Target {
                    name: server.name.clone(),
                    url: url.clone(),
                    headers: headers
                        .iter()
                        .filter(|(key, _)| !key.eq_ignore_ascii_case("authorization"))
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect(),
                });
            }
        }
        if targets.is_empty() {
            return Ok(None);
        }

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let authorization = format!("Bearer {}", uuid::Uuid::new_v4().simple());
        for (index, target) in targets.iter().enumerate() {
            if let Some(server) = servers.iter_mut().find(|server| server.name == target.name) {
                server.transport = McpTransport::Http {
                    url: format!("http://{address}/mcp/{index}"),
                    headers: std::collections::BTreeMap::from([(
                        "Authorization".to_string(),
                        authorization.clone(),
                    )]),
                };
            }
        }
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            // Credentials belong to the configured endpoint, never a redirect.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| DaemonError::Process(format!("MCP transport unavailable: {error}")))?;
        let state = Arc::new(ProxyState {
            app,
            workspace_id: workspace_id.to_string(),
            authorization,
            targets,
            client,
        });
        let router = Router::new()
            .route("/mcp/{index}", any(forward))
            .with_state(state);
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, router).await {
                tracing::warn!(%error, "OAuth MCP transport stopped");
            }
        });
        Ok(Some(Self { task }))
    }
}

fn auth_error(state: &ProxyState, target: &Target, message: String) -> Response {
    let _ = state
        .app
        .set_connector_auth_error(&state.workspace_id, &target.name, Some(&message));
    // A 401 would make Codex try its own OAuth against this local transport.
    // FalconDeck owns the login and supplies the recovery action instead.
    (StatusCode::BAD_GATEWAY, message).into_response()
}

async fn forward(
    State(state): State<Arc<ProxyState>>,
    Path(index): Path<usize>,
    request: Request,
) -> Response {
    if request.headers().contains_key(header::ORIGIN)
        || request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            != Some(state.authorization.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(target) = state.targets.get(index) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if !matches!(
        *request.method(),
        Method::GET | Method::POST | Method::DELETE
    ) {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let (parts, body) = request.into_parts();
    let body = match to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let mut token = match connector_oauth::refresh_access_token(&target.name).await {
        Ok(Some(token)) => token,
        Ok(None) => {
            return auth_error(
                &state,
                target,
                connector_oauth::reauthentication_message(&target.name),
            );
        }
        Err(error) => return auth_error(&state, target, error),
    };

    for attempt in 0..2 {
        let mut upstream = state
            .client
            .request(parts.method.clone(), &target.url)
            .body(body.clone());
        for (name, value) in &target.headers {
            upstream = upstream.header(name, value);
        }
        // Preserve MCP sessions, SSE resumption and content negotiation, but
        // never forward the local capability, browser cookies or host headers.
        for name in [
            "accept",
            "content-type",
            "mcp-session-id",
            "mcp-protocol-version",
            "last-event-id",
        ] {
            if let Some(value) = parts.headers.get(name) {
                upstream = upstream.header(name, value);
            }
        }
        upstream = upstream.bearer_auth(&token);
        let response = match tokio::time::timeout(Duration::from_secs(30), upstream.send()).await {
            Ok(Ok(response)) => response,
            _ => {
                return (
                    StatusCode::BAD_GATEWAY,
                    "MCP server did not respond. Try again shortly.",
                )
                    .into_response();
            }
        };
        if response.status() == StatusCode::UNAUTHORIZED {
            if attempt == 1 {
                let _ = connector_oauth::discard_rejected_access_token(&target.name, &token);
                return auth_error(
                    &state,
                    target,
                    connector_oauth::reauthentication_message(&target.name),
                );
            }
            token = match connector_oauth::refresh_rejected_token(&target.name, &token).await {
                Ok(Some(token)) => token,
                Ok(None) => {
                    return auth_error(
                        &state,
                        target,
                        connector_oauth::reauthentication_message(&target.name),
                    );
                }
                Err(error) => return auth_error(&state, target, error),
            };
            continue;
        }
        if response.status().is_redirection() {
            return (
                StatusCode::BAD_GATEWAY,
                "MCP endpoint redirected. Check its configuration in Plugins.",
            )
                .into_response();
        }
        if response.status().is_success() {
            let _ = state
                .app
                .set_connector_auth_error(&state.workspace_id, &target.name, None);
        }
        let status = response.status();
        let mut headers = axum::http::HeaderMap::new();
        for name in [
            "content-type",
            "mcp-session-id",
            "cache-control",
            "retry-after",
            "content-encoding",
        ] {
            if let Some(value) = response.headers().get(name) {
                headers.insert(axum::http::HeaderName::from_static(name), value.clone());
            }
        }
        // Do not buffer SSE: a tools/call response may stream for an entire turn.
        return (status, headers, Body::from_stream(response.bytes_stream())).into_response();
    }
    StatusCode::BAD_GATEWAY.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Json, http::HeaderMap, routing::post};
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[derive(Default)]
    struct Requests {
        tokens: Mutex<Vec<String>>,
        refreshes: Mutex<Vec<String>>,
        metadata: Mutex<Vec<(String, String)>>,
        reject_old: bool,
        invalid_grant: bool,
        rejected_request_barrier: Option<Arc<tokio::sync::Barrier>>,
    }

    async fn mcp(State(requests): State<Arc<Requests>>, headers: HeaderMap) -> Response {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        requests.tokens.lock().unwrap().push(authorization.clone());
        requests.metadata.lock().unwrap().push((
            headers
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
            headers
                .get("last-event-id")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string(),
        ));
        assert!(!headers.contains_key(header::COOKIE));
        if requests.reject_old && authorization == "Bearer old-access" {
            if let Some(barrier) = &requests.rejected_request_barrier {
                barrier.wait().await;
            }
            return StatusCode::UNAUTHORIZED.into_response();
        }
        (
            [
                ("content-type", "text/event-stream"),
                ("mcp-session-id", "upstream-session"),
            ],
            Body::from_stream(futures_util::stream::iter([
                Ok::<_, std::io::Error>("event: message\n"),
                Ok("data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n"),
            ])),
        )
            .into_response()
    }

    async fn refresh(State(requests): State<Arc<Requests>>, body: String) -> Response {
        requests.refreshes.lock().unwrap().push(body);
        if requests.invalid_grant {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"invalid_grant"})),
            )
                .into_response();
        }
        Json(json!({
            "access_token":"fresh-access", "refresh_token":"fresh-refresh", "expires_in":3600
        }))
        .into_response()
    }

    async fn upstream(requests: Arc<Requests>) -> (String, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/mcp", any(mcp))
            .route("/token", post(refresh))
            .with_state(requests);
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (url, task)
    }

    fn save(base: &str, access: &str, expired: bool) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        connector_oauth::save_token(
            "mobbin",
            connector_oauth::StoredToken {
                access_token: access.to_string(),
                refresh_token: Some("refresh-token".to_string()),
                expires_at: Some(if expired { now - 1 } else { now + 3600 }),
                token_endpoint: format!("{base}/token"),
                client_id: "test-client".to_string(),
            },
        )
        .unwrap();
    }

    async fn start(base: &str, app: AppState) -> (ConnectorProxy, String, String) {
        let mut servers = vec![McpServerConfig {
            name: "mobbin".to_string(),
            transport: McpTransport::Http {
                url: format!("{base}/mcp"),
                headers: BTreeMap::from([(
                    "Authorization".to_string(),
                    "Bearer old-access".to_string(),
                )]),
            },
        }];
        let proxy = ConnectorProxy::start(
            app,
            "workspace-1",
            &BTreeSet::from(["mobbin".to_string()]),
            &mut servers,
        )
        .await
        .unwrap()
        .unwrap();
        let McpTransport::Http { url, headers } = &servers[0].transport else {
            panic!("HTTP")
        };
        (proxy, url.clone(), headers["Authorization"].clone())
    }

    fn app(directory: &std::path::Path) -> AppState {
        AppState::new_with_state_path(
            "test".to_string(),
            Default::default(),
            directory.join("state.json"),
        )
    }

    #[tokio::test]
    async fn expired_credentials_and_new_logins_work_in_the_same_runtime() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let requests = Arc::new(Requests::default());
        let (base, upstream_task) = upstream(Arc::clone(&requests)).await;
        save(&base, "old-access", false);
        let (_proxy, url, authorization) = start(&base, app(directory.path())).await;
        let client = reqwest::Client::new();
        for (access, expired) in [
            ("old-access", false),
            ("old-access", true),
            ("browser-login", false),
        ] {
            save(&base, access, expired);
            let response = client
                .post(&url)
                .header(header::AUTHORIZATION, &authorization)
                .body("{}")
                .send()
                .await
                .unwrap();
            assert!(response.status().is_success());
            response.text().await.unwrap();
        }
        assert_eq!(
            *requests.tokens.lock().unwrap(),
            [
                "Bearer old-access",
                "Bearer fresh-access",
                "Bearer browser-login"
            ]
        );
        assert_eq!(requests.refreshes.lock().unwrap().len(), 1);
        upstream_task.abort();
    }

    #[tokio::test]
    async fn rejected_tokens_refresh_once_and_preserve_mcp_streams_and_session_headers() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let requests = Arc::new(Requests {
            reject_old: true,
            ..Default::default()
        });
        let (base, upstream_task) = upstream(Arc::clone(&requests)).await;
        save(&base, "old-access", false);
        let (_proxy, url, authorization) = start(&base, app(directory.path())).await;
        let response = reqwest::Client::new()
            .post(&url)
            .header(header::AUTHORIZATION, &authorization)
            .header("mcp-session-id", "existing-session")
            .header("last-event-id", "event-9")
            .header(header::COOKIE, "must-not-reach-provider")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.headers()["mcp-session-id"], "upstream-session");
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("data: {\"jsonrpc\"")
        );
        assert_eq!(
            *requests.tokens.lock().unwrap(),
            ["Bearer old-access", "Bearer fresh-access"]
        );
        assert_eq!(requests.refreshes.lock().unwrap().len(), 1);
        assert!(
            requests
                .metadata
                .lock()
                .unwrap()
                .iter()
                .all(|pair| pair == &("existing-session".to_string(), "event-9".to_string()))
        );
        upstream_task.abort();
    }

    #[tokio::test]
    async fn concurrent_rejections_rotate_a_refresh_grant_only_once() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let requests = Arc::new(Requests {
            reject_old: true,
            rejected_request_barrier: Some(Arc::new(tokio::sync::Barrier::new(2))),
            ..Default::default()
        });
        let (base, upstream_task) = upstream(Arc::clone(&requests)).await;
        save(&base, "old-access", false);
        let (_proxy, url, authorization) = start(&base, app(directory.path())).await;
        let client = reqwest::Client::new();
        let call = || {
            client
                .post(&url)
                .header(header::AUTHORIZATION, &authorization)
                .body("{}")
                .send()
        };
        let (first, second) = tokio::join!(call(), call());
        for response in [first.unwrap(), second.unwrap()] {
            assert!(response.status().is_success());
            response.text().await.unwrap();
        }
        assert_eq!(requests.refreshes.lock().unwrap().len(), 1);
        upstream_task.abort();
    }

    #[tokio::test]
    async fn stopping_the_runtime_closes_its_private_listener() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let (base, upstream_task) = upstream(Arc::new(Requests::default())).await;
        save(&base, "old-access", false);
        let (mut proxy, url, authorization) = start(&base, app(directory.path())).await;
        proxy.stop();
        assert!((&mut proxy.task).await.unwrap_err().is_cancelled());
        assert!(
            reqwest::Client::new()
                .post(&url)
                .header(header::AUTHORIZATION, authorization)
                .body("{}")
                .send()
                .await
                .is_err()
        );
        upstream_task.abort();
    }

    #[tokio::test]
    async fn local_capability_and_browser_origin_are_checked_before_forwarding() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let requests = Arc::new(Requests::default());
        let (base, upstream_task) = upstream(Arc::clone(&requests)).await;
        save(&base, "old-access", false);
        let (_proxy, url, authorization) = start(&base, app(directory.path())).await;
        let client = reqwest::Client::new();
        assert_eq!(
            client.post(&url).body("{}").send().await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            client
                .post(&url)
                .header(header::AUTHORIZATION, authorization)
                .header(header::ORIGIN, "https://example.com")
                .body("{}")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert!(requests.tokens.lock().unwrap().is_empty());
        assert!(requests.refreshes.lock().unwrap().is_empty());
        upstream_task.abort();
    }

    #[tokio::test]
    async fn rejected_grants_offer_reconnect_once_and_a_browser_login_clears_the_warning() {
        let _lock = connector_oauth::lock_store_for_test();
        let directory = tempfile::tempdir().unwrap();
        connector_oauth::set_store_path_for_test(directory.path().join("oauth.json"));
        let requests = Arc::new(Requests {
            invalid_grant: true,
            ..Default::default()
        });
        let (base, upstream_task) = upstream(Arc::clone(&requests)).await;
        save(&base, "old-access", false);
        let app = app(directory.path());
        let (_proxy, url, authorization) = start(&base, app.clone()).await;
        save(&base, "old-access", true);
        let client = reqwest::Client::new();
        let mut identity = None;
        for _ in 0..2 {
            let response = client
                .post(&url)
                .header(header::AUTHORIZATION, &authorization)
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
            assert!(
                response
                    .text()
                    .await
                    .unwrap()
                    .contains("Open Plugins and choose Reconnect")
            );
            let conditions = app.snapshot().await.operational_conditions;
            assert_eq!(conditions.len(), 1);
            assert_eq!(conditions[0].thread_id, None);
            assert_eq!(conditions[0].key, "mcp_auth:mobbin");
            let current = conditions[0].id.clone();
            assert_eq!(identity.get_or_insert(current.clone()), &current);
        }
        assert_eq!(requests.refreshes.lock().unwrap().len(), 1);
        assert!(connector_oauth::access_token("mobbin").is_none());
        save(&base, "new-browser-login", false);
        let response = client
            .post(&url)
            .header(header::AUTHORIZATION, &authorization)
            .body("{}")
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        response.text().await.unwrap();
        assert!(app.snapshot().await.operational_conditions.is_empty());
        upstream_task.abort();
    }
}
