//! Daemon-owned review inbox: decisions agents need from James, with frozen
//! evidence. Separate from tickets and from native conversation history.
//!
//! Storage is `<state dir>/reviews/reviews.json` plus one folder per review
//! (`reviews/R-12/evidence/…`) holding copies of small evidence files taken at
//! publish time, so what James approves cannot change underneath him.
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use falcondeck_core::FilePreviewKind;
use falcondeck_core::control::{
    ControlDomain, ControlExecuteRequest, ControlGetRequest, ControlGetResponse, ControlOrigin,
    ControlRequestContext,
};
use falcondeck_core::reviews::*;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::registry::{Capability, ops};
use super::service::{ControlDeps, ControlService, actor_name, decode_arguments};
use super::ControlError;
use crate::file_preview::{self, FileAccessPolicy, FileTarget};

/// Open reviews one agent (a bot, or a provider's task threads) may have at once.
const AGENT_OPEN_REVIEWS: usize = 5;
/// Evidence files up to this size are copied into the review folder.
const SNAPSHOT_MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// Copies per review stop here; later files stay as references.
const SNAPSHOT_MAX_REVIEW_BYTES: u64 = 48 * 1024 * 1024;
const MAX_ITEMS: usize = 12;
const MAX_EVIDENCE_PER_ITEM: usize = 12;
const MAX_FEEDBACK_CHARS: usize = 8_000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Records {
    version: u32,
    next_id: u64,
    reviews: Vec<Review>,
}
impl Default for Records {
    fn default() -> Self {
        Self {
            version: 1,
            next_id: 1,
            reviews: vec![],
        }
    }
}

/// Where a review came from, resolved by the daemon (never by the agent).
#[derive(Debug, Clone, Default)]
pub(super) struct ReviewSource {
    pub thread_id: Option<String>,
    pub workspace_id: Option<String>,
    pub bot: Option<String>,
}

/// What evidence paths may be read: the same policy phones use for `file.stat`.
pub(crate) struct EvidenceAccess {
    pub policy: FileAccessPolicy,
    pub home: Option<PathBuf>,
    pub workspace_dir: Option<PathBuf>,
}

pub(super) struct ReviewStore {
    dir: PathBuf,
    transaction: Mutex<()>,
}

impl ReviewStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            transaction: Mutex::new(()),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("reviews.json")
    }

    // Reload under the transaction lock. A bad or future file is never replaced
    // by an empty cache, and a failed save cannot leak into reads.
    async fn load(&self) -> Result<Records, ControlError> {
        let bytes = match tokio::fs::read(self.file()).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Records::default());
            }
            Err(error) => return Err(storage_error(error)),
        };
        let records: Records = serde_json::from_slice(&bytes).map_err(storage_error)?;
        if records.version != 1 || records.next_id == 0 {
            return Err(storage_error(
                "unsupported reviews schema version; file left untouched",
            ));
        }
        let mut ids = std::collections::HashSet::new();
        for review in &records.reviews {
            let number = review
                .id
                .strip_prefix("R-")
                .and_then(|id| id.parse::<u64>().ok());
            if number.is_none_or(|id| id == 0 || id >= records.next_id) || !ids.insert(&review.id) {
                return Err(storage_error(
                    "invalid review sequence; file left untouched",
                ));
            }
        }
        Ok(records)
    }

    async fn save(&self, records: &Records) -> Result<(), ControlError> {
        let payload = serde_json::to_vec_pretty(records).map_err(storage_error)?;
        crate::app::storage::write_atomically(&self.file(), payload)
            .await
            .map_err(storage_error)
    }

    /// `reviews`: newest first, open only unless `include_closed` or a `status`
    /// filter is given. `review`: one record by id.
    pub async fn get(
        &self,
        request: &ControlGetRequest,
    ) -> Result<ControlGetResponse, ControlError> {
        let _guard = self.transaction.lock().await;
        let records = self.load().await?;
        if request.resource == "review" {
            let id = request
                .id
                .as_deref()
                .ok_or_else(|| ControlError::field("id", "Supply a review id such as R-12."))?;
            return Ok(ControlGetResponse {
                resource: "review".into(),
                data: serde_json::to_value(find(&records, id)?).map_err(storage_error)?,
                next_cursor: None,
            });
        }
        let filters = &request.filters;
        let text = |key: &str| filters.get(key).and_then(serde_json::Value::as_str);
        let include_closed = filters
            .get("include_closed")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let offset = request
            .cursor
            .as_deref()
            .unwrap_or("0")
            .parse::<usize>()
            .map_err(|_| ControlError::field("cursor", "Invalid review cursor."))?;
        let limit = request.limit.clamp(1, 100) as usize;
        let mut rows: Vec<&Review> = records
            .reviews
            .iter()
            .filter(|review| {
                (include_closed || text("status").is_some() || review.status.is_open())
                    && text("status").is_none_or(|status| status_name(review.status) == status)
                    && text("bot").is_none_or(|bot| review.bot.as_deref() == Some(bot))
            })
            .collect();
        rows.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        let page: Vec<_> = rows.iter().skip(offset).take(limit).collect();
        Ok(ControlGetResponse {
            resource: "reviews".into(),
            data: serde_json::to_value(page).map_err(storage_error)?,
            next_cursor: (offset.saturating_add(limit) < rows.len())
                .then(|| (offset + limit).to_string()),
        })
    }

    pub async fn create(
        &self,
        args: CreateReviewArgs,
        actor: ReviewActor,
        source: ReviewSource,
        access: &EvidenceAccess,
    ) -> Result<Review, ControlError> {
        let title = args.title.trim().to_string();
        let ask = args.ask.trim().to_string();
        let recommendation = args.recommendation.trim().to_string();
        text_field("title", &title, 200, true)?;
        text_field("ask", &ask, 500, true)?;
        if ask.contains(['\n', '\r']) {
            return Err(ControlError::field(
                "ask",
                "Use one line for the ask; put detail in body or item notes.",
            ));
        }
        text_field("recommendation", &recommendation, 2_000, true)?;
        text_field("body", &args.body, 64_000, false)?;
        check_deadline(args.going_ahead_at)?;
        check_item_count(args.items.len(), 0)?;

        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let now = Utc::now();
        if !is_james(&actor) {
            let open = records
                .reviews
                .iter()
                .filter(|review| review.status.is_open() && review.created_by.name == actor.name)
                .count();
            if open >= AGENT_OPEN_REVIEWS {
                return Err(ControlError::new(
                    "review_limit",
                    format!(
                        "{} already has {open} open reviews, the most an agent may have waiting on James.",
                        actor.name
                    ),
                    false,
                )
                .with_suggested_action(
                    "Withdraw one that no longer matters or fold this into an open review as another item.",
                ));
            }
        }
        let id = format!("R-{}", records.next_id);
        let folder = self.dir.join(&id);
        let mut budget = SNAPSHOT_MAX_REVIEW_BYTES;
        let items = match build_items(args.items, 0, &folder, access, &mut budget).await {
            Ok(items) => items,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&folder).await;
                return Err(error);
            }
        };
        let review = Review {
            id,
            title,
            ask,
            recommendation,
            going_ahead_at: args.going_ahead_at,
            body: args.body,
            status: ReviewStatus::Open,
            items,
            source_thread_id: source.thread_id,
            source_workspace_id: source.workspace_id,
            bot: source.bot,
            created_by: actor,
            created_at: now,
            updated_at: now,
            folder: folder.exists().then(|| folder.to_string_lossy().into_owned()),
            responded_at: None,
            overall_decision: None,
            overall_note: None,
            delivery: None,
        };
        records.next_id = records
            .next_id
            .checked_add(1)
            .ok_or_else(|| storage_error("review sequence exhausted"))?;
        records.reviews.push(review.clone());
        if let Err(error) = self.save(&records).await {
            let _ = tokio::fs::remove_dir_all(&folder).await;
            return Err(error);
        }
        Ok(review)
    }

    pub async fn update(
        &self,
        args: UpdateReviewArgs,
        actor: ReviewActor,
        access: &EvidenceAccess,
    ) -> Result<Review, ControlError> {
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let mut review = find(&records, &args.review_id)?.clone();
        require_open_and_owned(&review, &actor)?;
        if let Some(value) = args.title {
            review.title = value.trim().into();
        }
        if let Some(value) = args.ask {
            review.ask = value.trim().into();
        }
        if let Some(value) = args.recommendation {
            review.recommendation = value.trim().into();
        }
        if let Some(value) = args.body {
            review.body = value;
        }
        if let Some(value) = args.going_ahead_at {
            review.going_ahead_at = match value.trim() {
                "" => None,
                value => {
                    let at = DateTime::parse_from_rfc3339(value)
                        .map_err(|_| {
                            ControlError::field(
                                "going_ahead_at",
                                "Use an RFC 3339 time with offset, or an empty string to clear it.",
                            )
                        })?
                        .with_timezone(&Utc);
                    check_deadline(Some(at))?;
                    Some(at)
                }
            };
        }
        text_field("title", &review.title, 200, true)?;
        text_field("ask", &review.ask, 500, true)?;
        if review.ask.contains(['\n', '\r']) {
            return Err(ControlError::field("ask", "Use one line for the ask."));
        }
        text_field("recommendation", &review.recommendation, 2_000, true)?;
        text_field("body", &review.body, 64_000, false)?;
        let mut folder_created = false;
        if !args.add_items.is_empty() {
            check_item_count(args.add_items.len(), review.items.len())?;
            let folder = self.dir.join(&review.id);
            folder_created = !folder.exists();
            let used: u64 = review
                .items
                .iter()
                .flat_map(|item| &item.evidence)
                .filter(|evidence| evidence.snapshotted)
                .filter_map(|evidence| evidence.size_bytes)
                .sum();
            let mut budget = SNAPSHOT_MAX_REVIEW_BYTES.saturating_sub(used);
            let start = next_item_number(&review);
            let added = build_items(args.add_items, start, &folder, access, &mut budget).await;
            match added {
                Ok(added) => review.items.extend(added),
                Err(error) => {
                    if folder_created {
                        let _ = tokio::fs::remove_dir_all(&folder).await;
                    }
                    return Err(error);
                }
            }
            if review.folder.is_none() && folder.exists() {
                review.folder = Some(folder.to_string_lossy().into_owned());
            }
        }
        review.updated_at = Utc::now();
        replace(&mut records, &review);
        if let Err(error) = self.save(&records).await {
            if folder_created {
                let _ = tokio::fs::remove_dir_all(self.dir.join(&review.id)).await;
            }
            return Err(error);
        }
        Ok(review)
    }

    pub async fn withdraw(
        &self,
        args: WithdrawReviewArgs,
        actor: ReviewActor,
    ) -> Result<Review, ControlError> {
        let reason = args
            .reason
            .as_deref()
            .map(str::trim)
            .filter(|reason| !reason.is_empty());
        if let Some(reason) = reason {
            text_field("reason", reason, 500, true)?;
        }
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let mut review = find(&records, &args.review_id)?.clone();
        require_open_and_owned(&review, &actor)?;
        review.status = ReviewStatus::Withdrawn;
        review.overall_note = reason.map(str::to_string);
        review.updated_at = Utc::now();
        replace(&mut records, &review);
        self.save(&records).await?;
        Ok(review)
    }

    /// Records James's decision. Only desktop and paired-device origins qualify;
    /// an agent can never answer its own review.
    pub async fn respond(
        &self,
        args: RespondReviewArgs,
        actor: ReviewActor,
    ) -> Result<Review, ControlError> {
        if !is_james(&actor) {
            return Err(ControlError::new(
                "review_forbidden",
                "Only James can respond to a review.",
                false,
            )
            .with_suggested_action("Wait for James; his decision arrives as a message in your thread."));
        }
        if let Some(note) = &args.note {
            text_field("note", note.trim(), MAX_FEEDBACK_CHARS, false)?;
        }
        for item in &args.items {
            if let Some(feedback) = &item.feedback {
                text_field("feedback", feedback.trim(), MAX_FEEDBACK_CHARS, false)?;
            }
        }
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let mut review = find(&records, &args.review_id)?.clone();
        if !review.status.is_open() {
            return Err(ControlError::new(
                "review_closed",
                format!(
                    "{} is already {}.",
                    review.id,
                    status_name(review.status).replace('_', " ")
                ),
                false,
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for response in &args.items {
            if !seen.insert(response.item_id.as_str()) {
                return Err(ControlError::field(
                    "items",
                    format!("Item {} appears twice.", response.item_id),
                ));
            }
            if !review.items.iter().any(|item| item.id == response.item_id) {
                return Err(ControlError::field(
                    "items",
                    format!("{} has no item {}.", review.id, response.item_id),
                ));
            }
        }
        for item in &mut review.items {
            let own = args.items.iter().find(|response| response.item_id == item.id);
            item.decision = own.map(|response| response.decision).or(args.decision);
            item.feedback = own.and_then(|response| nonempty(response.feedback.clone()));
            if item.decision.is_none() {
                return Err(ControlError::field(
                    "items",
                    format!(
                        "Item {} (\"{}\") needs a decision, or give one overall `decision`.",
                        item.id, item.title
                    ),
                ));
            }
        }
        review.overall_decision = args.decision;
        review.overall_note = nonempty(args.note);
        review.status = overall_status(&review.items);
        let now = Utc::now();
        review.responded_at = Some(now);
        review.updated_at = now;
        replace(&mut records, &review);
        self.save(&records).await?;
        Ok(review)
    }

    /// Records whether the reply reached the agent. Never fails the response.
    pub async fn set_delivery(
        &self,
        id: &str,
        delivery: ReviewDelivery,
    ) -> Result<Review, ControlError> {
        let _guard = self.transaction.lock().await;
        let mut records = self.load().await?;
        let mut review = find(&records, id)?.clone();
        review.delivery = Some(delivery);
        replace(&mut records, &review);
        self.save(&records).await?;
        Ok(review)
    }
}

impl ControlService {
    /// `review.*` operations. Create/update/withdraw belong to the agent that
    /// owns the review; respond belongs to James alone (checked by origin in the
    /// store, so no caller can talk its way past it).
    pub(super) async fn execute_review(
        &self,
        capability: &Capability,
        request: &ControlExecuteRequest,
        context: &ControlRequestContext,
        deps: &ControlDeps<'_>,
    ) -> Result<(serde_json::Value, Vec<ControlDomain>), ControlError> {
        let actor = ReviewActor {
            name: actor_name(context, deps).await,
            context: context.clone(),
        };
        let to_value = |review: &Review| {
            serde_json::to_value(review).map_err(|error| ControlError::internal(error.to_string()))
        };
        match capability.id {
            ops::REVIEW_CREATE => {
                let args: CreateReviewArgs = decode_arguments(&request.arguments)?;
                // Switched off: nothing is stored; the agent is handed the same
                // content as a plain message to send James itself.
                if let Some(app) = deps.app
                    && !app.review_inbox_enabled().await
                {
                    let message = fallback_message(&args);
                    return Ok((
                        serde_json::json!({
                            "review_inbox": "off",
                            "delivered_as": "message",
                            "message": message,
                            "instruction": "The review inbox is switched off, so no review was created. Send the text in `message` to James in your reply, as written.",
                        }),
                        vec![],
                    ));
                }
                let (source, access) = match deps.app {
                    Some(app) => {
                        let (workspace_id, bot) =
                            app.review_source(context.thread_id.as_deref()).await;
                        let access = app
                            .review_evidence_access(
                                workspace_id.as_deref(),
                                context.thread_id.as_deref(),
                            )
                            .await;
                        (
                            ReviewSource {
                                thread_id: context.thread_id.clone(),
                                workspace_id,
                                bot,
                            },
                            access,
                        )
                    }
                    None => (
                        ReviewSource {
                            thread_id: context.thread_id.clone(),
                            ..Default::default()
                        },
                        EvidenceAccess {
                            policy: FileAccessPolicy::default(),
                            home: None,
                            workspace_dir: None,
                        },
                    ),
                };
                let mut actor = actor;
                // A bot's reviews belong to the bot, not to whichever home thread
                // it had when it published.
                if let Some(bot) = &source.bot {
                    actor.name = bot.clone();
                }
                let review = self.reviews.create(args, actor, source, &access).await?;
                if let Some(app) = deps.app {
                    app.notify_review_created(&review).await;
                }
                Ok((to_value(&review)?, vec![ControlDomain::Reviews]))
            }
            ops::REVIEW_UPDATE => {
                let args: UpdateReviewArgs = decode_arguments(&request.arguments)?;
                let access = match deps.app {
                    Some(app) => {
                        let (workspace_id, _) =
                            app.review_source(context.thread_id.as_deref()).await;
                        app.review_evidence_access(
                            workspace_id.as_deref(),
                            context.thread_id.as_deref(),
                        )
                        .await
                    }
                    None => EvidenceAccess {
                        policy: FileAccessPolicy::default(),
                        home: None,
                        workspace_dir: None,
                    },
                };
                let review = self.reviews.update(args, actor, &access).await?;
                Ok((to_value(&review)?, vec![ControlDomain::Reviews]))
            }
            ops::REVIEW_WITHDRAW => {
                let args: WithdrawReviewArgs = decode_arguments(&request.arguments)?;
                let review = self.reviews.withdraw(args, actor).await?;
                Ok((to_value(&review)?, vec![ControlDomain::Reviews]))
            }
            ops::REVIEW_RESPOND => {
                let args: RespondReviewArgs = decode_arguments(&request.arguments)?;
                let review = self.reviews.respond(args, actor).await?;
                let delivery = match deps.app {
                    Some(app) => app.deliver_review_response(&review).await,
                    None => ReviewDelivery::Failed {
                        at: Utc::now(),
                        error: "daemon unavailable".into(),
                    },
                };
                let review = self.reviews.set_delivery(&review.id, delivery).await?;
                Ok((to_value(&review)?, vec![ControlDomain::Reviews]))
            }
            other => Err(ControlError::unknown_operation(other)),
        }
    }
}

/// One decision label for the review: changes beat rejection beat approval.
fn overall_status(items: &[ReviewItem]) -> ReviewStatus {
    let has = |wanted| items.iter().any(|item| item.decision == Some(wanted));
    if has(ReviewDecision::RequestChanges) {
        ReviewStatus::ChangesRequested
    } else if has(ReviewDecision::Reject) {
        ReviewStatus::Rejected
    } else {
        ReviewStatus::Approved
    }
}

/// The message James's response sends to the source thread. Feedback and the
/// overall note are quoted verbatim, one `> ` prefix per line.
pub(crate) fn response_message(review: &Review) -> String {
    fn quote(text: &str) -> String {
        text.lines()
            .map(|line| {
                if line.is_empty() {
                    ">".to_string()
                } else {
                    format!("> {line}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    fn label(decision: Option<ReviewDecision>) -> &'static str {
        match decision {
            Some(ReviewDecision::Approve) => "Approved",
            Some(ReviewDecision::RequestChanges) => "Changes requested",
            Some(ReviewDecision::Reject) => "Rejected",
            None => "No decision",
        }
    }
    let mut out = format!(
        "[FalconDeck review response] James responded to your review {} \"{}\".\nAsk: {}\nResult: {}\n",
        review.id,
        review.title,
        review.ask,
        match review.status {
            ReviewStatus::Approved => "Approved",
            ReviewStatus::ChangesRequested => "Changes requested",
            ReviewStatus::Rejected => "Rejected",
            ReviewStatus::Withdrawn => "Withdrawn",
            ReviewStatus::Open => "Open",
        }
    );
    if let Some(decision) = review.overall_decision {
        out.push_str(&format!("Whole-review decision: {}\n", label(Some(decision))));
    }
    let total = review.items.len();
    for (index, item) in review.items.iter().enumerate() {
        out.push_str(&format!(
            "\nItem {} of {}: {}\nDecision: {}\n",
            index + 1,
            total,
            item.title,
            label(item.decision)
        ));
        if let Some(feedback) = &item.feedback {
            out.push_str(&format!("Feedback:\n{}\n", quote(feedback)));
        }
    }
    if let Some(note) = &review.overall_note {
        out.push_str(&format!("\nNote from James on the whole review:\n{}\n", quote(note)));
    }
    out.push_str(
        "\nThis review is closed. Act on the decisions above; publish a new review if you need another decision.",
    );
    out
}

/// Plain-message form of a review, used when the review inbox is switched off.
pub(crate) fn fallback_message(args: &CreateReviewArgs) -> String {
    let mut out = format!(
        "# Decision needed: {}\n\n**Ask:** {}\n\n**Recommendation:** {}\n",
        args.title.trim(),
        args.ask.trim(),
        args.recommendation.trim()
    );
    if let Some(at) = args.going_ahead_at {
        out.push_str(&format!(
            "\n**Going ahead:** {} unless you say no.\n",
            at.format("%Y-%m-%d %H:%M UTC")
        ));
    }
    if !args.body.trim().is_empty() {
        out.push_str(&format!("\n{}\n", args.body.trim()));
    }
    for (index, item) in args.items.iter().enumerate() {
        out.push_str(&format!("\n## {}. {}\n", index + 1, item.title.trim()));
        if !item.note.trim().is_empty() {
            out.push_str(&format!("\n{}\n", item.note.trim()));
        }
        for evidence in &item.evidence {
            let target = evidence
                .path
                .as_deref()
                .or(evidence.url.as_deref())
                .unwrap_or("");
            let name = evidence
                .title
                .as_deref()
                .filter(|title| !title.trim().is_empty())
                .unwrap_or(target);
            out.push_str(&format!("- [{name}]({target})"));
            if let Some(caption) = evidence.caption.as_deref().filter(|c| !c.trim().is_empty()) {
                out.push_str(&format!(": {}", caption.trim()));
            }
            out.push('\n');
        }
    }
    out
}

async fn build_items(
    inputs: Vec<ReviewItemInput>,
    start: usize,
    folder: &Path,
    access: &EvidenceAccess,
    budget: &mut u64,
) -> Result<Vec<ReviewItem>, ControlError> {
    let mut items = Vec::with_capacity(inputs.len());
    for (offset, input) in inputs.into_iter().enumerate() {
        let id = format!("i{}", start + offset + 1);
        let title = input.title.trim().to_string();
        text_field("items.title", &title, 200, true)?;
        text_field("items.note", &input.note, 2_000, false)?;
        if input.evidence.len() > MAX_EVIDENCE_PER_ITEM {
            return Err(ControlError::field(
                "items.evidence",
                format!("At most {MAX_EVIDENCE_PER_ITEM} pieces of evidence per item."),
            ));
        }
        let mut evidence = Vec::with_capacity(input.evidence.len());
        for (index, raw) in input.evidence.into_iter().enumerate() {
            let evidence_id = format!("{id}e{}", index + 1);
            evidence.push(build_evidence(evidence_id, raw, folder, access, budget).await?);
        }
        items.push(ReviewItem {
            id,
            title,
            note: input.note.trim().to_string(),
            evidence,
            decision: None,
            feedback: None,
        });
    }
    Ok(items)
}

async fn build_evidence(
    id: String,
    raw: ReviewEvidenceInput,
    folder: &Path,
    access: &EvidenceAccess,
    budget: &mut u64,
) -> Result<ReviewEvidence, ControlError> {
    let title = nonempty(raw.title);
    let caption = nonempty(raw.caption);
    if let Some(title) = &title {
        text_field("evidence.title", title, 200, true)?;
    }
    if let Some(caption) = &caption {
        text_field("evidence.caption", caption, 300, true)?;
    }
    match (nonempty(raw.path), nonempty(raw.url)) {
        (Some(_), Some(_)) | (None, None) => Err(ControlError::field(
            "evidence",
            "Give each piece of evidence exactly one of path or url.",
        )),
        (None, Some(url)) => {
            text_field("evidence.url", &url, 2_048, true)?;
            let lower = url.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) {
                return Err(ControlError::field(
                    "evidence.url",
                    "Evidence links must be http or https.",
                ));
            }
            Ok(ReviewEvidence {
                id,
                kind: ReviewEvidenceKind::Url,
                title,
                caption,
                open_path: None,
                original_path: None,
                snapshotted: false,
                url: Some(url),
                content_type: None,
                size_bytes: None,
            })
        }
        (Some(path), None) => {
            text_field("evidence.path", &path, 4_096, true)?;
            let target = FileTarget {
                path: &path,
                base_dir: None,
                workspace_dir: access.workspace_dir.as_deref(),
                home: access.home.as_deref(),
            };
            let meta = file_preview::stat(&access.policy, target)
                .await
                .map_err(|error| {
                    ControlError::field(
                        "evidence.path",
                        format!(
                            "{path}: {}",
                            error.to_string().split_once(": ").map_or_else(
                                || error.to_string(),
                                |(_, rest)| rest.to_string()
                            )
                        ),
                    )
                })?;
            let kind = if meta.kind == FilePreviewKind::Image {
                ReviewEvidenceKind::Image
            } else {
                ReviewEvidenceKind::File
            };
            let mut open_path = meta.path.clone();
            let mut snapshotted = false;
            if meta.size_bytes <= SNAPSHOT_MAX_FILE_BYTES && meta.size_bytes <= *budget {
                let dest_dir = folder.join("evidence");
                tokio::fs::create_dir_all(&dest_dir)
                    .await
                    .map_err(storage_error)?;
                let dest = dest_dir.join(format!("{id}-{}", safe_name(&meta.name)));
                tokio::fs::copy(&meta.path, &dest)
                    .await
                    .map_err(storage_error)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = tokio::fs::set_permissions(
                        &dest,
                        std::fs::Permissions::from_mode(0o600),
                    )
                    .await;
                }
                *budget -= meta.size_bytes;
                open_path = dest.to_string_lossy().into_owned();
                snapshotted = true;
            }
            Ok(ReviewEvidence {
                id,
                kind,
                title: title.or_else(|| Some(meta.name.clone())),
                caption,
                open_path: Some(open_path),
                original_path: Some(meta.path),
                snapshotted,
                url: None,
                content_type: Some(meta.content_type),
                size_bytes: Some(meta.size_bytes),
            })
        }
    }
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = cleaned.trim_start_matches('.');
    let name = if trimmed.is_empty() { "file" } else { trimmed };
    name.chars().take(80).collect()
}

fn is_james(actor: &ReviewActor) -> bool {
    matches!(
        actor.context.origin,
        ControlOrigin::DesktopUi | ControlOrigin::RemoteRpc
    )
}

fn require_open_and_owned(review: &Review, actor: &ReviewActor) -> Result<(), ControlError> {
    if !review.status.is_open() {
        return Err(ControlError::new(
            "review_closed",
            format!(
                "{} is already {}.",
                review.id,
                status_name(review.status).replace('_', " ")
            ),
            false,
        ));
    }
    if !is_james(actor) && review.created_by.name != actor.name {
        return Err(ControlError::new(
            "review_forbidden",
            format!("{} belongs to {}; you can only change your own reviews.", review.id, review.created_by.name),
            false,
        ));
    }
    Ok(())
}

fn check_deadline(at: Option<DateTime<Utc>>) -> Result<(), ControlError> {
    if at.is_some_and(|at| at <= Utc::now()) {
        return Err(ControlError::field(
            "going_ahead_at",
            "going_ahead_at must be in the future.",
        ));
    }
    Ok(())
}

fn check_item_count(adding: usize, existing: usize) -> Result<(), ControlError> {
    if adding + existing == 0 || adding + existing > MAX_ITEMS {
        return Err(ControlError::field(
            "items",
            format!("A review needs 1-{MAX_ITEMS} items; one decision per review is best."),
        ));
    }
    Ok(())
}

fn next_item_number(review: &Review) -> usize {
    review
        .items
        .iter()
        .filter_map(|item| item.id.strip_prefix('i')?.parse::<usize>().ok())
        .max()
        .unwrap_or(0)
}

fn status_name(status: ReviewStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default()
}

fn nonempty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn replace(records: &mut Records, review: &Review) {
    if let Some(row) = records.reviews.iter_mut().find(|row| row.id == review.id) {
        *row = review.clone();
    }
}

fn find<'a>(records: &'a Records, id: &str) -> Result<&'a Review, ControlError> {
    records
        .reviews
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| ControlError::resource_not_found("review", id))
}

fn text_field(field: &str, value: &str, max: usize, required: bool) -> Result<(), ControlError> {
    if (required && value.trim().is_empty()) || value.chars().count() > max {
        return Err(ControlError::field(
            field,
            format!(
                "{field} must be {}-{max} characters.",
                usize::from(required)
            ),
        ));
    }
    Ok(())
}

fn storage_error(error: impl std::fmt::Display) -> ControlError {
    ControlError::new(
        "storage_unavailable",
        format!("Reviews storage: {error}"),
        false,
    )
}

#[cfg(test)]
mod tests;
