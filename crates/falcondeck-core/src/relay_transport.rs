//! Application-message chunking over an authenticated WebSocket. Encryption
//! remains end to end: fragments contain the existing ciphertext envelope and
//! must be reassembled before its AEAD authentication and application.

use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tokio::{
    sync::{OwnedSemaphorePermit, Semaphore, mpsc, oneshot, watch},
    time::{Duration, Instant},
};

/// Opt-in query value. Old servers ignore it and continue using legacy messages.
pub const TRANSPORT_VERSION: &str = "chunks-v1";
/// Raw fragment size leaves room for base64 and routing inside 16 KiB on wire.
pub const CHUNK_BYTES: usize = 11 * 1024;
/// Preserve the existing maximum attachment envelope size.
pub const MAX_MESSAGE_BYTES: usize = 40 * 1024 * 1024;
const QUEUE_BYTES: usize = MAX_MESSAGE_BYTES + 1024 * 1024;
const URGENT_BYTES: usize = 512 * 1024;
// Compact index and thread-page replies exceed one fragment after encryption.
// Send these bounded envelopes between bulk chunks instead of behind all history.
const MAX_URGENT_MESSAGE_BYTES: usize = 128 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
/// Chunks a sender keeps in flight before it needs an acknowledgement. One
/// chunk per round trip capped multi-megabyte transcripts at ~200 KB/s even on
/// a fast link and blew the relay's 30 s RPC lifetime from a phone; a window of
/// 32 (352 KB) fills a typical link while still bounding buffered bulk data.
/// Receivers acknowledge every chunk in order, so a windowed sender stays
/// compatible with peers that still send one chunk at a time.
pub const WINDOW_CHUNKS: usize = 32;
/// Acknowledgements the reader may queue for the writer. A windowed peer can
/// deliver a whole window before the writer finishes one chunk of its own.
const CONTROL_QUEUE: usize = 4 * WINDOW_CHUNKS;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Frame {
    TransportReady {
        version: String,
    },
    TransportChunk {
        id: u64,
        index: u32,
        total: usize,
        data: String,
    },
    TransportAck {
        id: u64,
        index: u32,
    },
    TransportCancel {
        id: u64,
    },
}

struct Assembly {
    id: u64,
    index: u32,
    total: usize,
    bytes: Vec<u8>,
    started: Instant,
    last_chunk: Instant,
}

/// A received logical message retains its memory permit until consumed.
pub struct Inbound {
    /// The original, complete application JSON, never a partial transfer.
    pub text: String,
    _permit: OwnedSemaphorePermit,
}

struct Outbound {
    text: String,
    generation: u64,
    queued: Instant,
    completed: Option<oneshot::Sender<Result<(), String>>>,
    _permit: OwnedSemaphorePermit,
}

/// The only producer interface to a socket's writer. Both lanes are byte bounded.
#[derive(Clone)]
pub struct TransportSender {
    urgent: mpsc::Sender<Outbound>,
    ordered: mpsc::Sender<Outbound>,
    urgent_bytes: Arc<Semaphore>,
    ordered_bytes: Arc<Semaphore>,
    generation: Arc<AtomicU64>,
    generation_notice: watch::Sender<u64>,
}

impl TransportSender {
    /// Enqueue an application message without waiting for socket capacity.
    /// Replies larger than the compact-envelope limit use the ordered lane.
    pub fn send(&self, text: String, urgent: bool) -> Result<(), String> {
        self.enqueue(text, urgent, None)
    }

    fn enqueue(
        &self,
        text: String,
        urgent: bool,
        completed: Option<oneshot::Sender<Result<(), String>>>,
    ) -> Result<(), String> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("relay message exceeds transport limit".into());
        }
        let urgent = urgent && text.len() <= MAX_URGENT_MESSAGE_BYTES;
        let (tx, budget) = if urgent {
            (&self.urgent, &self.urgent_bytes)
        } else {
            (&self.ordered, &self.ordered_bytes)
        };
        let permit = budget
            .clone()
            .try_acquire_many_owned(text.len().max(1) as u32)
            .map_err(|_| "relay outbound byte budget exhausted")?;
        tx.try_send(Outbound {
            text,
            generation: self.generation.load(Ordering::Acquire),
            queued: Instant::now(),
            completed,
            _permit: permit,
        })
        .map_err(|_| "relay outbound queue unavailable".into())
    }

    /// Wait for a small key/bootstrap barrier to reach the socket before using it.
    pub async fn send_barrier(&self, text: String) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.enqueue(text, true, Some(tx))?;
        tokio::time::timeout(DEADLINE, rx)
            .await
            .map_err(|_| "relay barrier timed out")?
            .map_err(|_| "relay writer closed")?
    }

    /// Invalidate ciphertext queued before a session-key rotation.
    pub fn advance_generation(&self) {
        let next = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        self.generation_notice.send_replace(next);
    }

    /// A completed handler may wait for bounded queue space without blocking reads.
    /// Its generation is captured at request receipt, never at result delivery.
    pub async fn send_result(&self, text: String, generation: u64) -> Result<(), String> {
        if text.len() > MAX_MESSAGE_BYTES {
            return Err("relay result exceeds transport limit".into());
        }
        let (tx, budget) = if text.len() <= MAX_URGENT_MESSAGE_BYTES {
            (&self.urgent, &self.urgent_bytes)
        } else {
            (&self.ordered, &self.ordered_bytes)
        };
        let permit = budget
            .clone()
            .acquire_many_owned(text.len().max(1) as u32)
            .await
            .map_err(|_| "relay result budget closed")?;
        if generation != self.generation.load(Ordering::Acquire) {
            return Ok(());
        }
        tx.send(Outbound {
            text,
            generation,
            queued: Instant::now(),
            completed: None,
            _permit: permit,
        })
        .await
        .map_err(|_| "relay writer closed".into())
    }
}

/// Owns the transport pumps. Dropping it cancels both halves of the connection.
pub struct TransportGuard {
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}
impl Drop for TransportGuard {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}

async fn write<S: Sink<String> + Unpin>(sink: &mut S, text: String) -> Result<(), String>
where
    S::Error: std::fmt::Display,
{
    tokio::time::timeout(DEADLINE, sink.send(text))
        .await
        .map_err(|_| "relay socket write timed out".to_string())?
        .map_err(|e| e.to_string())
}

async fn write_frame<S: Sink<String> + Unpin>(sink: &mut S, frame: Frame) -> Result<(), String>
where
    S::Error: std::fmt::Display,
{
    write(
        sink,
        serde_json::to_string(&frame).map_err(|e| e.to_string())?,
    )
    .await
}

/// Start an independently polled reader and a fair, bounded socket writer.
/// A server may enable chunks only after the client opted in via its URL.
/// A client waits for `transport-ready`, so older relays remain compatible.
pub fn spawn_transport<S, R, E>(
    mut sink: S,
    mut stream: R,
    server_chunks: bool,
) -> (
    TransportSender,
    mpsc::Receiver<Result<Inbound, String>>,
    TransportGuard,
)
where
    S: Sink<String> + Unpin + Send + 'static,
    S::Error: std::fmt::Display + Send,
    R: Stream<Item = Result<String, E>> + Unpin + Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    let (urgent_tx, mut urgent_rx) = mpsc::channel::<Outbound>(128);
    let (ordered_tx, mut ordered_rx) = mpsc::channel::<Outbound>(128);
    let (control_tx, mut control_rx) = mpsc::channel::<Frame>(CONTROL_QUEUE);
    let (ack_tx, mut ack_rx) = watch::channel((0u64, 0u32));
    let (incoming_tx, incoming_rx) = mpsc::channel(32);
    let enabled = Arc::new(AtomicBool::new(server_chunks));
    let generation = Arc::new(AtomicU64::new(0));
    let (generation_notice, mut generation_rx) = watch::channel(0u64);
    let sender = TransportSender {
        urgent: urgent_tx,
        ordered: ordered_tx,
        urgent_bytes: Arc::new(Semaphore::new(URGENT_BYTES)),
        ordered_bytes: Arc::new(Semaphore::new(QUEUE_BYTES)),
        generation: generation.clone(),
        generation_notice,
    };
    let reader_enabled = enabled.clone();
    let reader_incoming = incoming_tx.clone();
    let reader = tokio::spawn(async move {
        let mut assembly: Option<Assembly> = None;
        let budget = Arc::new(Semaphore::new(QUEUE_BYTES));
        let result: Result<(), String> = async {
            loop {
                let raw = if let Some(active) = &assembly {
                    tokio::time::timeout_at(
                        (active.started + Duration::from_secs(900))
                            .min(active.last_chunk + DEADLINE),
                        stream.next(),
                    )
                    .await
                    .map_err(|_| "relay transfer expired")?
                } else {
                    stream.next().await
                };
                let Some(raw) = raw else {
                    break;
                };
                let text = raw.map_err(|e| e.to_string())?;
                if text.len() > MAX_MESSAGE_BYTES {
                    return Err("relay incoming message too large".into());
                }
                // Ordinary envelopes never pay a second full JSON decode here.
                let reserved = text.starts_with("{\"type\":\"transport-");
                let completed = if reserved {
                    let frame: Frame = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                    match frame {
                        Frame::TransportReady { version } => {
                            if version != TRANSPORT_VERSION {
                                return Err("unsupported relay transport".into());
                            }
                            reader_enabled.store(true, Ordering::Release);
                            None
                        }
                        Frame::TransportAck { id, index } => {
                            ack_tx.send_replace((id, index));
                            None
                        }
                        Frame::TransportCancel { id } => {
                            if assembly.as_ref().is_some_and(|a| a.id == id) {
                                assembly = None;
                            }
                            None
                        }
                        Frame::TransportChunk {
                            id,
                            index,
                            total,
                            data,
                        } => {
                            if !reader_enabled.load(Ordering::Acquire)
                                || total == 0
                                || total > MAX_MESSAGE_BYTES
                                || data.len() > CHUNK_BYTES.div_ceil(3) * 4
                            {
                                return Err("invalid relay transport chunk".into());
                            }
                            if assembly.is_none() && index == 0 {
                                assembly = Some(Assembly {
                                    id,
                                    index: 0,
                                    total,
                                    bytes: Vec::new(),
                                    started: Instant::now(),
                                    last_chunk: Instant::now(),
                                });
                            }
                            let a = assembly.as_mut().ok_or("missing relay transfer start")?;
                            let bytes = STANDARD
                                .decode(data)
                                .map_err(|_| "invalid relay chunk encoding")?;
                            if a.id != id
                                || a.index != index
                                || a.total != total
                                || a.started.elapsed() > Duration::from_secs(900)
                                || bytes.is_empty()
                                || bytes.len() > CHUNK_BYTES
                                || a.bytes.len() + bytes.len() > total
                                || (bytes.len() < CHUNK_BYTES
                                    && a.bytes.len() + bytes.len() != total)
                            {
                                return Err("inconsistent relay transfer".into());
                            }
                            a.bytes.extend_from_slice(&bytes);
                            a.index += 1;
                            a.last_chunk = Instant::now();
                            control_tx
                                .try_send(Frame::TransportAck { id, index })
                                .map_err(|_| "relay acknowledgement queue full")?;
                            if a.bytes.len() == total {
                                Some(
                                    String::from_utf8(assembly.take().unwrap().bytes)
                                        .map_err(|_| "invalid relay transfer UTF-8")?,
                                )
                            } else {
                                None
                            }
                        }
                    }
                } else {
                    Some(text)
                };
                if let Some(text) = completed {
                    let permit = budget
                        .clone()
                        .acquire_many_owned(text.len().max(1) as u32)
                        .await
                        .map_err(|_| "relay receive budget closed")?;
                    reader_incoming
                        .send(Ok(Inbound {
                            text,
                            _permit: permit,
                        }))
                        .await
                        .map_err(|_| "relay reader closed")?;
                }
            }
            Err("relay socket closed".into())
        }
        .await;
        if let Err(error) = result {
            let _ = reader_incoming.send(Err(error)).await;
        }
    });
    let writer = tokio::spawn(async move {
        let result: Result<(), String> = async {
            if server_chunks { write_frame(&mut sink, Frame::TransportReady { version: TRANSPORT_VERSION.into() }).await?; }
            let mut transfer_id = 0u64;
            let mut urgent_run = 0;
            loop {
                // Fairness: after eight urgent messages, service an available ordered message.
                let next = if urgent_run >= 8 { ordered_rx.try_recv().ok().map(|v| (v, false)) } else { None };
                let (mut message, urgent) = match next {
                    Some(v) => v,
                    None => tokio::select! {
                        biased;
                        control = control_rx.recv() => { if let Some(frame) = control { write_frame(&mut sink, frame).await?; continue; } else { return Err("relay reader stopped".into()); } }
                        message = urgent_rx.recv() => { (message.ok_or("relay urgent queue closed")?, true) }
                        message = ordered_rx.recv() => { (message.ok_or("relay ordered queue closed")?, false) }
                    },
                };
                urgent_run = if urgent { urgent_run + 1 } else { 0 };
                if message.generation != generation.load(Ordering::Acquire) { continue; }
                let started = Instant::now();
                let bytes = message.text.len();
                if !urgent && enabled.load(Ordering::Acquire) && bytes > CHUNK_BYTES {
                    transfer_id += 1;
                    let chunks: Vec<&[u8]> = message.text.as_bytes().chunks(CHUNK_BYTES).collect();
                    let total_chunks = chunks.len();
                    let mut next = 0usize;
                    let mut acked = 0usize;
                    let deadline = tokio::time::sleep(DEADLINE); tokio::pin!(deadline);
                    loop {
                        if message.generation != generation.load(Ordering::Acquire) {
                            write_frame(&mut sink, Frame::TransportCancel { id: transfer_id }).await?;
                            break;
                        }
                        // Absorb acknowledgements that arrived while writing.
                        {
                            let (id, index) = *ack_rx.borrow_and_update();
                            if id == transfer_id && (index as usize + 1) > acked {
                                acked = index as usize + 1;
                                deadline.as_mut().reset(Instant::now() + DEADLINE);
                            }
                        }
                        if acked >= total_chunks { break; }
                        // Fill the window. Urgent replies still slip in between chunks.
                        while next < total_chunks && next - acked < WINDOW_CHUNKS {
                            for _ in 0..8 {
                                let Ok(mut urgent) = urgent_rx.try_recv() else { break; };
                                if urgent.generation == generation.load(Ordering::Acquire) {
                                    write(&mut sink, std::mem::take(&mut urgent.text)).await?;
                                    if let Some(done) = urgent.completed.take() { let _ = done.send(Ok(())); }
                                }
                            }
                            while let Ok(frame) = control_rx.try_recv() { write_frame(&mut sink, frame).await?; }
                            write_frame(&mut sink, Frame::TransportChunk { id: transfer_id, index: next as u32, total: bytes, data: STANDARD.encode(chunks[next]) }).await?;
                            next += 1;
                            if message.generation != generation.load(Ordering::Acquire) { break; }
                        }
                        // The window is full (or fully sent): wait for credit. Incoming
                        // reads and urgent replies continue while the peer consumes it.
                        tokio::select! {
                            biased;
                            control = control_rx.recv() => { write_frame(&mut sink, control.ok_or("relay reader stopped")?).await?; }
                            _ = &mut deadline => return Err("relay chunk acknowledgement timed out".into()),
                            changed = generation_rx.changed() => { changed.map_err(|_| "relay generation owner closed")?; }
                            changed = ack_rx.changed() => { changed.map_err(|_| "relay reader stopped")?; }
                            urgent = urgent_rx.recv() => {
                                let mut urgent = urgent.ok_or("relay urgent queue closed")?;
                                if urgent.generation == generation.load(Ordering::Acquire) {
                                    write(&mut sink, std::mem::take(&mut urgent.text)).await?;
                                    if let Some(done) = urgent.completed.take() { let _ = done.send(Ok(())); }
                                }
                            }
                        }
                    }
                } else { write(&mut sink, std::mem::take(&mut message.text)).await?; }
                tracing::debug!(bytes, queue_ms = started.duration_since(message.queued).as_millis(), write_ms = started.elapsed().as_millis(), "relay transport message written");
                if let Some(done) = message.completed.take() { let _ = done.send(Ok(())); }
            }
        }.await;
        if let Err(error) = result {
            let _ = incoming_tx.send(Err(error)).await;
        }
    });
    (sender, incoming_rx, TransportGuard { reader, writer })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stalled_bulk_does_not_block_incoming_requests_or_urgent_replies() {
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(4);
        let (peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(4);
        let sink = Box::pin(futures_util::sink::unfold(wire_tx, |tx, text| async move {
            tx.send(text).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(tx)
        }));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (sender, mut incoming, _guard) = spawn_transport(sink, stream, true);
        assert!(wire_rx.recv().await.unwrap().contains("transport-ready"));
        sender
            .send("x".repeat(CHUNK_BYTES * (WINDOW_CHUNKS + 8)), false)
            .unwrap();
        // A full window leaves without credit; the receiver withholds it,
        // simulating a saturated phone.
        let mut transfer_id = 0;
        for expected in 0..WINDOW_CHUNKS {
            let frame: serde_json::Value =
                serde_json::from_str(&wire_rx.recv().await.unwrap()).unwrap();
            assert_eq!(frame["type"], "transport-chunk");
            assert_eq!(frame["index"], expected as u64);
            transfer_id = frame["id"].as_u64().unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), wire_rx.recv())
                .await
                .is_err(),
            "bulk must wait for credit"
        );
        peer_tx
            .send(Ok(r#"{"type":"rpc-request","request_id":"fast"}"#.into()))
            .await
            .unwrap();
        let request = tokio::time::timeout(Duration::from_millis(100), incoming.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(request.text.contains("fast"));
        sender
            .send(r#"{"type":"rpc-result","request_id":"fast"}"#.into(), true)
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_millis(100), wire_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(reply.contains("rpc-result"));
        // One acknowledgement opens exactly one chunk of credit.
        peer_tx
            .send(Ok(serde_json::to_string(&Frame::TransportAck {
                id: transfer_id,
                index: 0,
            })
            .unwrap()))
            .await
            .unwrap();
        let frame: serde_json::Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_millis(200), wire_rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(frame["index"], WINDOW_CHUNKS as u64);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), wire_rx.recv())
                .await
                .is_err(),
            "credit is per acknowledgement"
        );
        sender.advance_generation();
        let cancel = tokio::time::timeout(Duration::from_millis(200), wire_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(cancel.contains("transport-cancel"));
        sender
            .send_result("old-key-result".into(), 0)
            .await
            .unwrap();
        sender.send("new-key-result".into(), true).unwrap();
        assert_eq!(wire_rx.recv().await.unwrap(), "new-key-result");
    }

    #[tokio::test]
    async fn windowed_sender_is_not_bound_by_round_trip_time() {
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(64);
        let (peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(64);
        let sink = Box::pin(futures_util::sink::unfold(wire_tx, |tx, text| async move {
            tx.send(text).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(tx)
        }));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (sender, _incoming, _guard) = spawn_transport(sink, stream, true);
        wire_rx.recv().await.unwrap();
        // 3 MB ≈ a full Codex transcript; 150 ms RTT ≈ a phone on LTE.
        let text = "x".repeat(3 * 1024 * 1024);
        let expected_chunks = text.len().div_ceil(CHUNK_BYTES);
        let started = Instant::now();
        let (done_tx, done_rx) = oneshot::channel();
        sender.enqueue(text, false, Some(done_tx)).unwrap();
        let acknowledgements = peer_tx.clone();
        let peer = tokio::spawn(async move {
            let mut received = 0usize;
            while let Some(text) = wire_rx.recv().await {
                if let Ok(Frame::TransportChunk { id, index, .. }) = serde_json::from_str(&text) {
                    received += 1;
                    let ack = acknowledgements.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        let _ = ack
                            .send(Ok(serde_json::to_string(&Frame::TransportAck {
                                id,
                                index,
                            })
                            .unwrap()))
                            .await;
                    });
                    if received == expected_chunks {
                        break;
                    }
                }
            }
            received
        });
        tokio::time::timeout(Duration::from_secs(10), done_rx)
            .await
            .expect("transfer completes")
            .unwrap()
            .unwrap();
        let elapsed = started.elapsed();
        assert_eq!(peer.await.unwrap(), expected_chunks);
        // Stop-and-wait would need expected_chunks × 150 ms ≈ 42 s here.
        assert!(
            elapsed < Duration::from_secs(5),
            "3 MB at 150 ms RTT took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn slow_link_keeps_compact_and_small_replies_responsive_during_multi_megabyte_sync() {
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(4);
        let (peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(4);
        let sink = Box::pin(futures_util::sink::unfold(
            wire_tx,
            |tx, text: String| async move {
                // 512 kbit/s; model receiver acknowledgements at 150 ms RTT below.
                tokio::time::sleep(Duration::from_secs_f64(text.len() as f64 / 64_000.0)).await;
                tx.send(text).await.map_err(|e| e.to_string())?;
                Ok::<_, String>(tx)
            },
        ));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (sender, mut incoming, _guard) = spawn_transport(sink, stream, true);
        wire_rx.recv().await.unwrap();
        sender.send("x".repeat(5 * 1024 * 1024), false).unwrap();
        let acknowledgements = peer_tx.clone();
        let (replies_tx, mut replies_rx) = mpsc::channel(4);
        let (started_tx, started_rx) = oneshot::channel();
        let chunks = Arc::new(AtomicU64::new(0));
        let received_chunks = chunks.clone();
        let peer = tokio::spawn(async move {
            let mut started_tx = Some(started_tx);
            while let Some(text) = wire_rx.recv().await {
                if let Ok(Frame::TransportChunk { id, index, .. }) = serde_json::from_str(&text) {
                    received_chunks.fetch_add(1, Ordering::Relaxed);
                    if let Some(started_tx) = started_tx.take() {
                        started_tx.send(()).unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    acknowledgements
                        .send(Ok(serde_json::to_string(&Frame::TransportAck {
                            id,
                            index,
                        })
                        .unwrap()))
                        .await
                        .unwrap();
                } else {
                    replies_tx.send(text).await.unwrap();
                }
            }
        });
        started_rx.await.unwrap();
        let mut latencies = Vec::new();
        let mut compact_latencies = Vec::new();
        for n in 0..10 {
            let started = Instant::now();
            peer_tx.send(Ok(format!("request-{n}"))).await.unwrap();
            let request = tokio::time::timeout(Duration::from_millis(100), incoming.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            // The production compact index's encrypted envelope is about 86 KiB,
            // well above one chunk. Exercise daemon results and relay forwarding.
            let expected = if n == 0 || n == 5 {
                serde_json::json!({ "type": "rpc-result", "ciphertext": "x".repeat(86 * 1024) })
                    .to_string()
            } else {
                format!("reply-{}", request.text)
            };
            if n == 0 {
                sender.send_result(expected.clone(), 0).await.unwrap();
            } else {
                sender.send(expected.clone(), true).unwrap();
            }
            let reply = tokio::time::timeout(Duration::from_secs(3), replies_rx.recv())
                .await
                .expect("interactive reply must not wait for the 5 MiB bulk transfer")
                .unwrap();
            assert_eq!(reply, expected);
            if n == 0 || n == 5 {
                compact_latencies.push(started.elapsed().as_millis());
            } else {
                latencies.push(started.elapsed().as_millis());
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        latencies.sort();
        eprintln!(
            "512 kbit/s + 150 ms RTT: small RPC worst={} ms; 86 KiB replies={compact_latencies:?} ms; bulk chunks={}",
            latencies.last().unwrap(),
            chunks.load(Ordering::Relaxed)
        );
        assert!(*latencies.last().unwrap() < 2000);
        assert!(compact_latencies.iter().all(|elapsed| *elapsed < 3000));
        assert!(
            chunks.load(Ordering::Relaxed) > 1,
            "bulk also makes progress"
        );
        peer.abort();
    }

    #[tokio::test]
    async fn compact_reply_during_assembly_preserves_the_bulk_message() {
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(4);
        let (peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(4);
        let sink = Box::pin(futures_util::sink::unfold(wire_tx, |tx, text| async move {
            tx.send(text).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(tx)
        }));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (_sender, mut incoming, _guard) = spawn_transport(sink, stream, true);
        wire_rx.recv().await.unwrap();
        let bulk = "x".repeat(CHUNK_BYTES * 2);
        let compact = serde_json::json!({
            "type": "rpc-result", "ciphertext": "y".repeat(86 * 1024),
        })
        .to_string();
        for (index, chunk) in bulk.as_bytes().chunks(CHUNK_BYTES).enumerate() {
            peer_tx
                .send(Ok(serde_json::to_string(&Frame::TransportChunk {
                    id: 1,
                    index: index as u32,
                    total: bulk.len(),
                    data: STANDARD.encode(chunk),
                })
                .unwrap()))
                .await
                .unwrap();
            wire_rx.recv().await.unwrap();
            if index == 0 {
                peer_tx.send(Ok(compact.clone())).await.unwrap();
                assert_eq!(incoming.recv().await.unwrap().unwrap().text, compact);
            }
        }
        assert_eq!(incoming.recv().await.unwrap().unwrap().text, bulk);
    }

    #[tokio::test]
    async fn compact_replies_keep_urgent_admission_byte_bounded() {
        // Block the initial Ready write so queued messages retain their permits.
        let sink = Box::pin(futures_util::sink::unfold((), |(), _text: String| async {
            std::future::pending::<Result<(), String>>().await
        }));
        let stream = futures_util::stream::pending::<Result<String, String>>();
        let (sender, _incoming, _guard) = spawn_transport(sink, stream, true);
        for _ in 0..URGENT_BYTES / MAX_URGENT_MESSAGE_BYTES {
            sender
                .send("x".repeat(MAX_URGENT_MESSAGE_BYTES), true)
                .unwrap();
        }
        assert!(sender.send("full".into(), true).is_err());
        assert!(
            tokio::time::timeout(
                Duration::from_millis(50),
                sender.send_result("full".into(), 0),
            )
            .await
            .is_err(),
            "async results must also honor the urgent byte budget"
        );
        sender
            .send("x".repeat(MAX_URGENT_MESSAGE_BYTES + 1), true)
            .expect("oversized replies retain their separate ordered budget");
    }

    #[tokio::test]
    async fn one_chunk_at_a_time_uploader_is_acknowledged_promptly() {
        // A peer still running the pre-window sender waits for every ack.
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(64);
        let (peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(64);
        let sink = Box::pin(futures_util::sink::unfold(wire_tx, |tx, text| async move {
            tx.send(text).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(tx)
        }));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (_sender, mut incoming, _guard) = spawn_transport(sink, stream, true);
        wire_rx.recv().await.unwrap();
        let text = "y".repeat(1024 * 1024);
        let started = Instant::now();
        let mut worst = Duration::ZERO;
        for (index, chunk) in text.as_bytes().chunks(CHUNK_BYTES).enumerate() {
            let sent = Instant::now();
            peer_tx
                .send(Ok(serde_json::to_string(&Frame::TransportChunk {
                    id: 7,
                    index: index as u32,
                    total: text.len(),
                    data: STANDARD.encode(chunk),
                })
                .unwrap()))
                .await
                .unwrap();
            let ack = tokio::time::timeout(Duration::from_secs(2), wire_rx.recv())
                .await
                .expect("ack within 2s")
                .unwrap();
            assert!(ack.contains("transport-ack"), "{ack}");
            worst = worst.max(sent.elapsed());
        }
        let received = incoming.recv().await.unwrap().unwrap();
        assert_eq!(received.text, text);
        eprintln!("1 MB legacy upload: {:?}, worst ack {:?}", started.elapsed(), worst);
        assert!(worst < Duration::from_millis(200));
    }

    #[tokio::test]
    async fn legacy_peer_receives_original_message_and_queue_is_byte_bounded() {
        let (wire_tx, mut wire_rx) = mpsc::channel::<String>(4);
        let (_peer_tx, peer_rx) = mpsc::channel::<Result<String, String>>(4);
        let sink = Box::pin(futures_util::sink::unfold(wire_tx, |tx, text| async move {
            tx.send(text).await.map_err(|e| e.to_string())?;
            Ok::<_, String>(tx)
        }));
        let stream = Box::pin(futures_util::stream::unfold(peer_rx, |mut rx| async {
            rx.recv().await.map(|v| (v, rx))
        }));
        let (sender, _incoming, _guard) = spawn_transport(sink, stream, false);
        let text = "x".repeat(CHUNK_BYTES * 2);
        sender.send(text.clone(), false).unwrap();
        assert_eq!(wire_rx.recv().await.unwrap(), text);
        sender.send("x".repeat(MAX_MESSAGE_BYTES), false).unwrap();
        assert!(sender.send("x".repeat(2 * 1024 * 1024), false).is_err());
    }
}
