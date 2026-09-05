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
const DEADLINE: Duration = Duration::from_secs(30);

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
    /// Large replies use the ordered lane even when their request was urgent.
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
        let urgent = urgent && text.len() <= CHUNK_BYTES;
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
        let (tx, budget) = if text.len() <= CHUNK_BYTES {
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
    let (control_tx, mut control_rx) = mpsc::channel::<Frame>(8);
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
                if enabled.load(Ordering::Acquire) && bytes > CHUNK_BYTES {
                    transfer_id += 1;
                    for (index, chunk) in message.text.as_bytes().chunks(CHUNK_BYTES).enumerate() {
                        if message.generation != generation.load(Ordering::Acquire) {
                            write_frame(&mut sink, Frame::TransportCancel { id: transfer_id }).await?; break;
                        }
                        for _ in 0..8 {
                            let Ok(mut urgent) = urgent_rx.try_recv() else { break; };
                            if urgent.generation == generation.load(Ordering::Acquire) {
                                write(&mut sink, std::mem::take(&mut urgent.text)).await?;
                                if let Some(done) = urgent.completed.take() { let _ = done.send(Ok(())); }
                            }
                        }
                        write_frame(&mut sink, Frame::TransportChunk { id: transfer_id, index: index as u32, total: bytes, data: STANDARD.encode(chunk) }).await?;
                        let deadline = tokio::time::sleep(DEADLINE); tokio::pin!(deadline);
                        // One outstanding chunk bounds buffered bulk data. Incoming reads and
                        // urgent replies continue while this receiver consumes it.
                        loop {
                            if message.generation != generation.load(Ordering::Acquire) || *ack_rx.borrow() == (transfer_id, index as u32) { break; }
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
        sender.send("x".repeat(CHUNK_BYTES * 8), false).unwrap();
        let first: serde_json::Value =
            serde_json::from_str(&wire_rx.recv().await.unwrap()).unwrap();
        assert_eq!(first["type"], "transport-chunk");
        // Withhold the receiver's chunk credit, simulating a saturated phone.
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
        assert!(wire_rx.try_recv().is_err(), "bulk must wait for credit");
        sender.advance_generation();
        let cancel = tokio::time::timeout(Duration::from_millis(100), wire_rx.recv())
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
    async fn slow_link_keeps_small_replies_responsive_during_multi_megabyte_sync() {
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
        let chunks = Arc::new(AtomicU64::new(0));
        let received_chunks = chunks.clone();
        let peer = tokio::spawn(async move {
            while let Some(text) = wire_rx.recv().await {
                if let Ok(Frame::TransportChunk { id, index, .. }) = serde_json::from_str(&text) {
                    received_chunks.fetch_add(1, Ordering::Relaxed);
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
        let mut latencies = Vec::new();
        for n in 0..10 {
            let started = Instant::now();
            peer_tx.send(Ok(format!("request-{n}"))).await.unwrap();
            let request = tokio::time::timeout(Duration::from_millis(100), incoming.recv())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            sender
                .send(format!("reply-{}", request.text), true)
                .unwrap();
            let reply = tokio::time::timeout(Duration::from_secs(2), replies_rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply, format!("reply-request-{n}"));
            latencies.push(started.elapsed().as_millis());
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        latencies.sort();
        eprintln!(
            "512 kbit/s + 150 ms RTT: small RPC p95={} ms; bulk chunks={}",
            latencies[9],
            chunks.load(Ordering::Relaxed)
        );
        assert!(latencies[9] < 2000);
        assert!(
            chunks.load(Ordering::Relaxed) > 1,
            "bulk also makes progress"
        );
        peer.abort();
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
