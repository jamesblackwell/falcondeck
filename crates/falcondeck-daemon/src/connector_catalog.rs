//! Curated MCP servers shown in Plugins.
//!
//! These are not a marketplace dump. Each card is a server FalconDeck knows
//! how to install: a remote URL plus either an API key or an OAuth flow the
//! daemon brokers once, then injects as a Bearer token into every harness.

use serde::Serialize;
use serde_json::{Value, json};

use crate::connector_oauth;
use crate::connectors;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogAuth {
    Oauth,
    ApiKey,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogServer {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub url: &'static str,
    pub auth: CatalogAuth,
    /// Public website domain used to fetch a logo (not the MCP host).
    pub domain: &'static str,
    pub featured: bool,
    /// RFC 8707 resource indicator; defaults to the origin of `url` when None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource: Option<&'static str>,
    /// Space-separated OAuth scopes. Omitted when the server's default is fine.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<&'static str>,
}

pub const CATALOG: &[CatalogServer] = &[
    CatalogServer {
        id: "notion",
        name: "Notion",
        description: "Search and edit your Notion workspace.",
        category: "Productivity",
        url: "https://mcp.notion.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "notion.so",
        featured: true,
        resource: Some("https://mcp.notion.com"),
        scopes: Some("default"),
    },
    CatalogServer {
        id: "linear",
        name: "Linear",
        description: "Issues, projects, and roadmaps.",
        category: "Productivity",
        url: "https://mcp.linear.app/mcp",
        auth: CatalogAuth::Oauth,
        domain: "linear.app",
        featured: true,
        resource: Some("https://mcp.linear.app/mcp"),
        scopes: Some("read write"),
    },
    CatalogServer {
        id: "atlassian",
        name: "Atlassian",
        description: "Jira and Confluence for your site.",
        category: "Productivity",
        url: "https://mcp.atlassian.com/v1/mcp",
        auth: CatalogAuth::Oauth,
        domain: "atlassian.com",
        featured: true,
        resource: None,
        scopes: None,
    },
    CatalogServer {
        id: "github",
        name: "GitHub",
        description: "Triage PRs, issues, CI, and publish flows.",
        category: "Developer tools",
        url: "https://api.githubcopilot.com/mcp/",
        auth: CatalogAuth::ApiKey,
        domain: "github.com",
        featured: true,
        resource: Some("https://api.githubcopilot.com/mcp"),
        scopes: None,
    },
    CatalogServer {
        id: "canva",
        name: "Canva",
        description: "Create, review, and edit designs.",
        category: "Creativity",
        url: "https://mcp.canva.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "canva.com",
        featured: true,
        resource: Some("https://mcp.canva.com"),
        scopes: Some(
            "profile:read design:meta:read design:content:read design:content:write folder:read folder:write",
        ),
    },
    CatalogServer {
        id: "stripe",
        name: "Stripe",
        description: "Payments, customers, and billing.",
        category: "Commerce",
        url: "https://mcp.stripe.com",
        auth: CatalogAuth::Oauth,
        domain: "stripe.com",
        featured: true,
        resource: Some("https://mcp.stripe.com"),
        scopes: None,
    },
    CatalogServer {
        id: "asana",
        name: "Asana",
        description: "Tasks, projects, and team work.",
        category: "Productivity",
        url: "https://mcp.asana.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "asana.com",
        featured: false,
        resource: Some("https://mcp.asana.com"),
        scopes: Some("default"),
    },
    CatalogServer {
        id: "clickup",
        name: "ClickUp",
        description: "Tasks and docs in ClickUp.",
        category: "Productivity",
        url: "https://mcp.clickup.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "clickup.com",
        featured: false,
        resource: Some("https://mcp.clickup.com"),
        scopes: Some("read write"),
    },
    CatalogServer {
        id: "airtable",
        name: "Airtable",
        description: "Bases, records, and comments.",
        category: "Productivity",
        url: "https://mcp.airtable.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "airtable.com",
        featured: false,
        resource: Some("https://mcp.airtable.com"),
        scopes: Some("data.records:read data.records:write schema.bases:read"),
    },
    CatalogServer {
        id: "intercom",
        name: "Intercom",
        description: "Customer conversations and tickets.",
        category: "Productivity",
        url: "https://mcp.intercom.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "intercom.com",
        featured: false,
        resource: None,
        scopes: None,
    },
    CatalogServer {
        id: "fireflies",
        name: "Fireflies",
        description: "Search meeting transcripts.",
        category: "Productivity",
        url: "https://api.fireflies.ai/mcp",
        auth: CatalogAuth::Oauth,
        domain: "fireflies.ai",
        featured: false,
        resource: Some("https://api.fireflies.ai/mcp"),
        scopes: Some("profile email"),
    },
    CatalogServer {
        id: "gitlab",
        name: "GitLab",
        description: "Merge requests, issues, and projects.",
        category: "Developer tools",
        url: "https://gitlab.com/api/v4/mcp",
        auth: CatalogAuth::Oauth,
        domain: "gitlab.com",
        featured: false,
        resource: Some("https://gitlab.com/api/v4/mcp"),
        scopes: Some("mcp"),
    },
    CatalogServer {
        id: "sentry",
        name: "Sentry",
        description: "Errors, projects, and issue triage.",
        category: "Developer tools",
        url: "https://mcp.sentry.dev/mcp",
        auth: CatalogAuth::Oauth,
        domain: "sentry.io",
        featured: false,
        resource: Some("https://mcp.sentry.dev/mcp"),
        scopes: Some("org:read project:write team:write event:write"),
    },
    CatalogServer {
        id: "vercel",
        name: "Vercel",
        description: "Projects, deployments, and domains.",
        category: "Developer tools",
        url: "https://mcp.vercel.com",
        auth: CatalogAuth::Oauth,
        domain: "vercel.com",
        featured: false,
        resource: Some("https://mcp.vercel.com/"),
        scopes: Some("openid"),
    },
    CatalogServer {
        id: "cloudflare",
        name: "Cloudflare",
        description: "Workers, DNS, and account tools.",
        category: "Developer tools",
        url: "https://mcp.cloudflare.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "cloudflare.com",
        featured: false,
        resource: Some("https://mcp.cloudflare.com/mcp"),
        scopes: None,
    },
    CatalogServer {
        id: "context7",
        name: "Context7",
        description: "Up-to-date library documentation for coding agents.",
        category: "Developer tools",
        url: "https://mcp.context7.com/mcp",
        auth: CatalogAuth::ApiKey,
        domain: "context7.com",
        featured: false,
        resource: None,
        scopes: None,
    },
    CatalogServer {
        id: "huggingface",
        name: "Hugging Face",
        description: "Models, datasets, and inference.",
        category: "Developer tools",
        url: "https://huggingface.co/mcp",
        auth: CatalogAuth::Oauth,
        domain: "huggingface.co",
        featured: false,
        resource: Some("https://huggingface.co/mcp"),
        scopes: Some("openid profile read-mcp read-repos"),
    },
    CatalogServer {
        id: "posthog",
        name: "PostHog",
        description: "Product analytics, flags, and session replay.",
        category: "Developer tools",
        url: "https://mcp.posthog.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "posthog.com",
        featured: false,
        resource: Some("https://mcp.posthog.com"),
        scopes: Some("openid profile email"),
    },
    CatalogServer {
        id: "buildkite",
        name: "Buildkite",
        description: "Pipelines, builds, and annotations.",
        category: "Developer tools",
        url: "https://mcp.buildkite.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "buildkite.com",
        featured: false,
        resource: Some("https://mcp.buildkite.com/mcp"),
        scopes: None,
    },
    CatalogServer {
        id: "fal-ai",
        name: "fal",
        description: "Generate images, video, and audio with fal models.",
        category: "Creativity",
        url: "https://mcp.fal.ai/mcp",
        auth: CatalogAuth::ApiKey,
        domain: "fal.ai",
        featured: false,
        resource: None,
        scopes: None,
    },
    CatalogServer {
        id: "webflow",
        name: "Webflow",
        description: "CMS items, pages, and site structure.",
        category: "Creativity",
        url: "https://mcp.webflow.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "webflow.com",
        featured: false,
        resource: Some("https://mcp.webflow.com"),
        scopes: None,
    },
    CatalogServer {
        id: "wix",
        name: "Wix",
        description: "Site content and business tools.",
        category: "Creativity",
        url: "https://mcp.wix.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "wix.com",
        featured: false,
        resource: Some("https://mcp.wix.com"),
        scopes: Some("offline_access"),
    },
    CatalogServer {
        id: "paypal",
        name: "PayPal",
        description: "Payments and transaction data.",
        category: "Commerce",
        url: "https://mcp.paypal.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "paypal.com",
        featured: false,
        resource: Some("https://mcp.paypal.com"),
        scopes: None,
    },
    CatalogServer {
        id: "square",
        name: "Square",
        description: "Orders, catalog, and payments.",
        category: "Commerce",
        url: "https://mcp.squareup.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "squareup.com",
        featured: false,
        resource: Some("https://mcp.squareup.com/mcp"),
        scopes: None,
    },
    CatalogServer {
        id: "amplitude",
        name: "Amplitude",
        description: "Product analytics for your workspace.",
        category: "Developer tools",
        url: "https://mcp.amplitude.com/mcp",
        auth: CatalogAuth::Oauth,
        domain: "amplitude.com",
        featured: false,
        resource: Some("https://mcp.amplitude.com"),
        scopes: Some("mcp:read mcp:write"),
    },
];

pub fn get(id: &str) -> Option<&'static CatalogServer> {
    CATALOG.iter().find(|server| server.id == id)
}

/// Catalog plus whether each card is already installed and signed in.
pub fn overview() -> Value {
    let installed_names = connectors::global_server_names();
    let servers: Vec<Value> = CATALOG
        .iter()
        .map(|server| {
            let installed = installed_names.contains(server.id);
            let connected = match server.auth {
                CatalogAuth::Oauth => {
                    installed && connector_oauth::access_token(server.id).is_some()
                }
                CatalogAuth::ApiKey => installed,
            };
            json!({
                "id": server.id,
                "name": server.name,
                "description": server.description,
                "category": server.category,
                "url": server.url,
                "auth": server.auth,
                "domain": server.domain,
                "featured": server.featured,
                "installed": installed,
                "connected": connected,
            })
        })
        .collect();
    json!({ "servers": servers })
}

pub fn install_api_key(id: &str, api_key: &str) -> Result<(), String> {
    let server = get(id).ok_or_else(|| format!("unknown catalog server {id:?}"))?;
    if server.auth != CatalogAuth::ApiKey {
        return Err(format!("{id} is installed with OAuth, not an API key"));
    }
    let key = api_key.trim();
    if key.is_empty() || key.len() > 512 {
        return Err("invalid API key".to_string());
    }
    let mut headers = std::collections::BTreeMap::new();
    headers.insert("Authorization".to_string(), format!("Bearer {key}"));
    connectors::upsert_global_http_connector(server.id, server.url, None, headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_are_unique_and_url_based() {
        let mut seen = std::collections::BTreeSet::new();
        let mut featured = 0;
        for server in CATALOG {
            assert!(seen.insert(server.id), "duplicate catalog id {}", server.id);
            assert!(server.url.starts_with("https://"));
            assert!(
                !server.domain.is_empty() && !server.domain.contains('/'),
                "invalid logo domain {}",
                server.domain
            );
            if server.featured {
                featured += 1;
            }
        }
        assert!(featured >= 4, "featured row needs a handful of servers");
    }
}
