use falcondeck_core::DEFAULT_TITLE_SUGGESTION_MODEL;
use serde_json::{Value, json};
use tokio::time::Duration;

use super::{
    AppState,
    conversation_helpers::normalize_generated_thread_title,
    speech::{OPENROUTER_CHAT_URL, OPENROUTER_CLIENT},
};
use crate::error::DaemonError;

// Remote RPCs have a roughly 30-second budget, including credential lookup.
const TITLE_TIMEOUT: Duration = Duration::from_secs(20);

impl AppState {
    pub(super) async fn request_openrouter_thread_title(
        &self,
        prompt: &str,
    ) -> Result<String, DaemonError> {
        let model = self
            .inner
            .preferences
            .lock()
            .await
            .title_suggestion_model
            .clone();
        let api_key = self.openrouter_key_cached().await?.ok_or_else(|| {
            DaemonError::BadRequest(
                "Add an OpenRouter API key in Speech settings to suggest a title.".to_string(),
            )
        })?;
        request_title(
            &OPENROUTER_CLIENT,
            OPENROUTER_CHAT_URL,
            &api_key,
            &model,
            prompt,
        )
        .await
    }
}

async fn request_title(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, DaemonError> {
    let mut body = json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": 256,
    });
    if model == DEFAULT_TITLE_SUGGESTION_MODEL {
        body["reasoning"] = json!({ "effort": "none" });
    }
    let response = client
        .post(url)
        .bearer_auth(api_key)
        .header("X-Title", "FalconDeck")
        .timeout(TITLE_TIMEOUT)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                DaemonError::Process("OpenRouter title suggestion timed out.".to_string())
            } else {
                DaemonError::Process(format!("OpenRouter title suggestion failed: {error}"))
            }
        })?;
    let status = response.status();
    if !status.is_success() {
        let message = match status.as_u16() {
            401 => "The OpenRouter API key was rejected.".to_string(),
            402 => "The OpenRouter account needs credit to suggest titles.".to_string(),
            429 => "OpenRouter is rate limited; try suggesting a title again shortly.".to_string(),
            code => format!("OpenRouter title suggestion failed ({code})."),
        };
        return Err(DaemonError::Process(message));
    }
    let body = response.json::<Value>().await.map_err(|error| {
        DaemonError::Process(format!("Invalid OpenRouter title response: {error}"))
    })?;
    parse_title_response(&body)
}

fn parse_title_response(body: &Value) -> Result<String, DaemonError> {
    let choice = body
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    if choice
        .and_then(|choice| choice.get("finish_reason"))
        .and_then(Value::as_str)
        == Some("length")
    {
        return Err(DaemonError::Process(
            "OpenRouter cut off the title suggestion.".to_string(),
        ));
    }
    let content = choice
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"));
    let text = match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    };
    normalize_generated_thread_title(&text).ok_or_else(|| {
        DaemonError::Process("OpenRouter returned no usable title suggestion.".to_string())
    })
}

#[cfg(test)]
mod tests {
    use axum::{Json, Router, http::HeaderMap, routing::post};

    use super::*;

    #[tokio::test]
    async fn title_request_uses_luna_and_returns_a_normalized_candidate() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let router = Router::new().route(
            "/",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let tx = tx.clone();
                async move {
                    tx.send((headers, body)).unwrap();
                    Json(json!({
                        "choices": [{
                            "finish_reason": "stop",
                            "message": { "content": "\"Improve Sidebar Search\"" }
                        }]
                    }))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        for model in [DEFAULT_TITLE_SUGGESTION_MODEL, "openai/gpt-5.6-luna"] {
            let title = request_title(
                &reqwest::Client::new(),
                &url,
                "test-key",
                model,
                "Recent work",
            )
            .await
            .unwrap();
            let (headers, body) = rx.recv().await.unwrap();
            assert_eq!(title, "Improve Sidebar Search");
            assert_eq!(headers.get("authorization").unwrap(), "Bearer test-key");
            assert_eq!(body["model"], model);
            assert_eq!(body["messages"][0]["content"], "Recent work");
            if model == DEFAULT_TITLE_SUGGESTION_MODEL {
                assert_eq!(body["reasoning"]["effort"], "none");
            } else {
                assert!(body.get("reasoning").is_none());
            }
        }
        server.abort();
    }

    #[test]
    fn title_response_rejects_truncated_or_empty_content() {
        let truncated = json!({
            "choices": [{ "finish_reason": "length", "message": { "content": "Improve" } }]
        });
        assert!(parse_title_response(&truncated).is_err());
        let empty = json!({ "choices": [{ "message": { "content": "" } }] });
        assert!(parse_title_response(&empty).is_err());
    }
}
