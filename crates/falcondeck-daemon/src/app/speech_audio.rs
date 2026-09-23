use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use tracing::debug;
use uuid::Uuid;

pub const SAMPLE_RATE: u32 = 16000;
pub const FRAME_SIZE: usize = 320; // 20ms at 16kHz
pub const MIN_AUDIO_DURATION_SECS: f64 = 0.5;
pub const MIN_SAVED_SECS: f64 = 0.8;
pub const MIN_SAVED_RATIO: f64 = 0.05;
pub const SPEECH_CUSHION_FRAMES: usize = 10; // 200ms padding around speech
pub const MAX_LEADING_SILENCE_FRAMES: usize = 15; // 300ms leading silence preserved
pub const MAX_TRAILING_SILENCE_FRAMES: usize = 15; // 300ms trailing silence preserved
pub const MAX_INTERNAL_PAUSE_EXPANDED_FRAMES: usize = 15; // ~700ms raw pause preserved

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AudioTool {
    Afconvert,
    Ffmpeg,
}

static AUDIO_TOOL: OnceLock<Option<AudioTool>> = OnceLock::new();

pub fn detect_audio_tool() -> Option<AudioTool> {
    *AUDIO_TOOL.get_or_init(|| {
        if cfg!(target_os = "macos") && Path::new("/usr/bin/afconvert").exists() {
            Some(AudioTool::Afconvert)
        } else if is_command_available("ffmpeg") {
            Some(AudioTool::Ffmpeg)
        } else {
            None
        }
    })
}

fn is_command_available(cmd: &str) -> bool {
    Command::new(cmd)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Parse a 16kHz 16-bit mono PCM WAV file (standard or WAVE_FORMAT_EXTENSIBLE).
pub fn read_wav_16k_mono(bytes: &[u8]) -> Option<Vec<i16>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12;
    let mut is_16k_mono = false;
    let mut samples_bytes = None;

    while offset + 8 <= bytes.len() {
        let tag = &bytes[offset..offset + 4];
        let chunk_size =
            u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
        let payload_start = offset + 8;
        let payload_end = (payload_start + chunk_size).min(bytes.len());
        let payload = &bytes[payload_start..payload_end];

        if tag == b"fmt " && payload.len() >= 16 {
            let audio_format = u16::from_le_bytes(payload[0..2].try_into().ok()?);
            let channels = u16::from_le_bytes(payload[2..4].try_into().ok()?);
            let sample_rate = u32::from_le_bytes(payload[4..8].try_into().ok()?);
            let bits_per_sample = u16::from_le_bytes(payload[14..16].try_into().ok()?);

            let is_pcm = audio_format == 1
                || (audio_format == 0xFFFE && payload.len() >= 26 && payload[24..26] == [1, 0]);
            if is_pcm && channels == 1 && sample_rate == SAMPLE_RATE && bits_per_sample == 16 {
                is_16k_mono = true;
            }
        } else if tag == b"data" {
            samples_bytes = Some(payload);
            break;
        }

        let mut next_offset = offset + 8 + chunk_size;
        if chunk_size % 2 == 1 {
            next_offset += 1;
        }
        if next_offset <= offset {
            break;
        }
        offset = next_offset;
    }

    if !is_16k_mono {
        return None;
    }

    let payload = samples_bytes?;
    let mut samples = Vec::with_capacity(payload.len() / 2);
    for &pair in payload.as_chunks::<2>().0 {
        samples.push(i16::from_le_bytes(pair));
    }
    Some(samples)
}

/// Write standard 16kHz 16-bit mono PCM WAV bytes.
pub fn write_wav_16k_mono(samples: &[i16]) -> Vec<u8> {
    let num_samples = samples.len() as u32;
    let byte_rate = SAMPLE_RATE * 2;
    let block_align = 2u16;
    let bits_per_sample = 16u16;
    let data_len = num_samples * 2;
    let file_len = 36 + data_len;

    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&file_len.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits_per_sample.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Compact silence and long pauses from 16kHz 16-bit mono audio.
/// Returns Some(compacted_samples) if meaningful silence was removed,
/// or None if the audio was already compact or savings were negligible.
pub fn compact_silence_16k_mono(samples: &[i16]) -> Option<Vec<i16>> {
    let num_samples = samples.len();
    if num_samples < (SAMPLE_RATE as f64 * MIN_AUDIO_DURATION_SECS) as usize {
        return None;
    }

    let num_frames = num_samples / FRAME_SIZE;
    if num_frames == 0 {
        return None;
    }

    // 1. Calculate frame RMS energies
    let mut energies = Vec::with_capacity(num_frames);
    for frame_idx in 0..num_frames {
        let start = frame_idx * FRAME_SIZE;
        let frame = &samples[start..start + FRAME_SIZE];
        let sum_sq: f64 = frame.iter().map(|&s| (s as f64) * (s as f64)).sum();
        let rms = (sum_sq / FRAME_SIZE as f64).sqrt() as f32;
        energies.push(rms);
    }

    // 2. Determine ambient noise floor and speech threshold
    let mut sorted_energies = energies.clone();
    sorted_energies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise_floor_idx = (num_frames * 15) / 100;
    let noise_floor = sorted_energies[noise_floor_idx];
    let speech_threshold = (noise_floor * 2.5).max(60.0);

    // 3. Mark speech frames
    let is_speech: Vec<bool> = energies.iter().map(|&e| e > speech_threshold).collect();
    // No frame above the threshold means the clip is all ambient noise.
    let first_speech = is_speech.iter().position(|&s| s)?;
    let last_speech = is_speech.iter().rposition(|&s| s).unwrap_or(first_speech);

    // 4. Expand speech regions with cushion
    let mut expanded = vec![false; num_frames];
    for (i, &speech) in is_speech.iter().enumerate() {
        if speech {
            let start = i.saturating_sub(SPEECH_CUSHION_FRAMES);
            let end = (i + SPEECH_CUSHION_FRAMES + 1).min(num_frames);
            for frame in &mut expanded[start..end] {
                *frame = true;
            }
        }
    }

    // 5. Build frame keep mask
    let mut keep_mask = vec![true; num_frames];

    // Trim excessive leading silence
    let leading_keep_start = first_speech.saturating_sub(MAX_LEADING_SILENCE_FRAMES);
    for frame in &mut keep_mask[..leading_keep_start] {
        *frame = false;
    }

    // Trim excessive trailing silence
    let trailing_keep_end = (last_speech + MAX_TRAILING_SILENCE_FRAMES + 1).min(num_frames);
    for frame in &mut keep_mask[trailing_keep_end..] {
        *frame = false;
    }

    // Compress internal pauses longer than threshold
    let mut in_gap = false;
    let mut gap_start = 0;
    for i in first_speech..=last_speech {
        if !expanded[i] && keep_mask[i] {
            if !in_gap {
                in_gap = true;
                gap_start = i;
            }
        } else if in_gap {
            in_gap = false;
            let gap_len = i - gap_start;
            if gap_len > MAX_INTERNAL_PAUSE_EXPANDED_FRAMES {
                for frame in &mut keep_mask[gap_start..i] {
                    *frame = false;
                }
            }
        }
    }

    // 6. Check if savings justify processing
    let dropped_frames = keep_mask.iter().filter(|&&k| !k).count();
    let dropped_seconds = (dropped_frames * FRAME_SIZE) as f64 / SAMPLE_RATE as f64;
    let orig_seconds = samples.len() as f64 / SAMPLE_RATE as f64;

    if dropped_seconds < MIN_SAVED_SECS || (dropped_seconds / orig_seconds) < MIN_SAVED_RATIO {
        return None;
    }

    // 7. Splicing with smooth crossfade
    let mut output_samples = Vec::with_capacity(samples.len() - dropped_frames * FRAME_SIZE);
    let mut segment_start = None;

    for (i, &keep) in keep_mask.iter().enumerate() {
        if keep {
            if segment_start.is_none() {
                segment_start = Some(i * FRAME_SIZE);
            }
        } else if let Some(start) = segment_start.take() {
            let end = i * FRAME_SIZE;
            append_segment_with_crossfade(&mut output_samples, &samples[start..end]);
        }
    }
    if let Some(start) = segment_start.take() {
        let end = num_frames * FRAME_SIZE;
        append_segment_with_crossfade(&mut output_samples, &samples[start..end]);
    }

    Some(output_samples)
}

fn append_segment_with_crossfade(output: &mut Vec<i16>, next_segment: &[i16]) {
    if next_segment.is_empty() {
        return;
    }
    if output.is_empty() {
        output.extend_from_slice(next_segment);
        return;
    }
    const CROSSFADE_LEN: usize = 32; // 2ms at 16kHz
    let fade_len = CROSSFADE_LEN.min(output.len()).min(next_segment.len());
    let out_start = output.len() - fade_len;
    for (k, (old, &new)) in output[out_start..]
        .iter_mut()
        .zip(&next_segment[..fade_len])
        .enumerate()
    {
        let w_new = (k + 1) as f32 / (fade_len + 1) as f32;
        *old = (*old as f32 * (1.0 - w_new) + new as f32 * w_new).round() as i16;
    }
    output.extend_from_slice(&next_segment[fade_len..]);
}

fn decode_audio_to_wav(tool: AudioTool, input_path: &Path, wav_path: &Path) -> bool {
    let status = match tool {
        AudioTool::Afconvert => Command::new("/usr/bin/afconvert")
            .args(["-f", "WAVE", "-d", "LEI16@16000", "-c", "1"])
            .arg(input_path)
            .arg("-o")
            .arg(wav_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
        AudioTool::Ffmpeg => Command::new("ffmpeg")
            .args(["-y", "-i"])
            .arg(input_path)
            .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "wav"])
            .arg(wav_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    };
    status.map(|s| s.success()).unwrap_or(false)
}

fn encode_wav_to_m4a(tool: AudioTool, wav_path: &Path, m4a_path: &Path) -> bool {
    let status = match tool {
        AudioTool::Afconvert => Command::new("/usr/bin/afconvert")
            .args(["-f", "m4af", "-d", "aac", "-b", "32000", "-c", "1"])
            .arg(wav_path)
            .arg("-o")
            .arg(m4a_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
        AudioTool::Ffmpeg => Command::new("ffmpeg")
            .args(["-y", "-i"])
            .arg(wav_path)
            .args(["-vn", "-c:a", "aac", "-b:a", "32k", "-ac", "1"])
            .arg(m4a_path)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    };
    status.map(|s| s.success()).unwrap_or(false)
}

/// Optimizes speech audio by trimming leading/trailing dead air and compacting
/// long internal pauses while preserving natural pauses and phonetic cues.
///
/// Returns (compacted_bytes, output_format, new_duration_seconds).
/// If compaction is skipped or fails, returns the original audio unchanged.
pub async fn compact_speech_audio(
    audio: Vec<u8>,
    format: &str,
    duration_seconds: Option<f64>,
) -> (Vec<u8>, String, Option<f64>) {
    let format_clean = format.trim().trim_start_matches('.').to_ascii_lowercase();

    let audio_clone = audio.clone();
    let format_clone = format_clean.clone();

    let result = tokio::task::spawn_blocking(move || {
        compact_speech_audio_blocking(audio_clone, &format_clone)
    })
    .await;

    match result {
        Ok(Some((compacted_bytes, out_format, new_duration))) => {
            debug!(
                original_bytes = audio.len(),
                compacted_bytes = compacted_bytes.len(),
                output_format = %out_format,
                new_duration = new_duration,
                "Speech audio pause compaction succeeded"
            );
            (compacted_bytes, out_format, Some(new_duration))
        }
        _ => (audio, format_clean, duration_seconds),
    }
}

fn compact_speech_audio_blocking(audio: Vec<u8>, format: &str) -> Option<(Vec<u8>, String, f64)> {
    let tool = detect_audio_tool()?;

    // 1. Obtain 16kHz mono PCM samples
    let samples = if format == "wav" {
        read_wav_16k_mono(&audio)
    } else {
        None
    };

    let samples = match samples {
        Some(s) => s,
        None => {
            // Need to decode via tool
            let temp_dir = std::env::temp_dir();
            let session_id = Uuid::new_v4();
            let in_path = temp_dir.join(format!("falcondeck-speech-in-{session_id}.{format}"));
            let wav_path = temp_dir.join(format!("falcondeck-speech-dec-{session_id}.wav"));

            let _in_guard = TempFileGuard(in_path.clone());
            let _wav_guard = TempFileGuard(wav_path.clone());

            std::fs::write(&in_path, &audio).ok()?;
            if !decode_audio_to_wav(tool, &in_path, &wav_path) {
                return None;
            }

            let decoded_bytes = std::fs::read(&wav_path).ok()?;
            read_wav_16k_mono(&decoded_bytes)?
        }
    };

    // 2. Compact silence / pauses
    let compacted_samples = compact_silence_16k_mono(&samples)?;
    let new_duration = compacted_samples.len() as f64 / SAMPLE_RATE as f64;

    // 3. Encode to output M4A (or WAV if format was WAV and no encoder)
    let temp_dir = std::env::temp_dir();
    let session_id = Uuid::new_v4();
    let comp_wav_path = temp_dir.join(format!("falcondeck-speech-comp-{session_id}.wav"));
    let out_m4a_path = temp_dir.join(format!("falcondeck-speech-out-{session_id}.m4a"));

    let _comp_wav_guard = TempFileGuard(comp_wav_path.clone());
    let _out_m4a_guard = TempFileGuard(out_m4a_path.clone());

    let comp_wav_bytes = write_wav_16k_mono(&compacted_samples);
    std::fs::write(&comp_wav_path, &comp_wav_bytes).ok()?;

    if encode_wav_to_m4a(tool, &comp_wav_path, &out_m4a_path)
        && let Ok(m4a_bytes) = std::fs::read(&out_m4a_path)
        && !m4a_bytes.is_empty()
    {
        return Some((m4a_bytes, "m4a".to_string(), new_duration));
    }

    // Fallback if M4A encoding failed: if input was WAV, return compacted WAV
    if format == "wav" {
        return Some((comp_wav_bytes, "wav".to_string(), new_duration));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_16k_mono() {
        let original_samples: Vec<i16> = (0..3200)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        let wav_bytes = write_wav_16k_mono(&original_samples);
        let read_samples = read_wav_16k_mono(&wav_bytes).expect("Should parse WAV");
        assert_eq!(original_samples, read_samples);
    }

    #[test]
    fn compact_silence_skips_short_audio() {
        let short_samples = vec![0i16; 1600]; // 100ms
        assert!(compact_silence_16k_mono(&short_samples).is_none());
    }

    #[test]
    fn compact_silence_skips_pure_noise() {
        let noise_samples = vec![20i16; 32000]; // 2 seconds of low noise
        assert!(compact_silence_16k_mono(&noise_samples).is_none());
    }

    #[test]
    fn compact_silence_trims_leading_trailing_and_internal_gaps() {
        // 16000 samples/sec
        // 2 seconds leading silence (32000 samples)
        // 1 second speech (16000 samples)
        // 2 seconds internal silence (32000 samples)
        // 1 second speech (16000 samples)
        // 2 seconds trailing silence (32000 samples)
        // Total: 8 seconds (128000 samples)
        let mut samples = Vec::new();

        // 2s leading silence
        samples.extend(vec![15i16; 32000]);

        // 1s tone
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16);
        }

        // 2s internal silence
        samples.extend(vec![15i16; 32000]);

        // 1s tone
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16);
        }

        // 2s trailing silence
        samples.extend(vec![15i16; 32000]);

        let compacted = compact_silence_16k_mono(&samples).expect("Should compact");
        let compacted_duration = compacted.len() as f64 / 16000.0;

        // Original is 8.0s. Compacted should preserve speech + safe cushions (~3-4s total).
        assert!(
            compacted_duration < 5.0,
            "Expected duration < 5.0, got {compacted_duration}"
        );
        assert!(
            compacted_duration > 2.0,
            "Expected duration > 2.0, got {compacted_duration}"
        );
    }

    #[test]
    fn crossfade_splicing_prevents_discontinuities() {
        let mut out = vec![1000i16; 100];
        let next = vec![-1000i16; 100];
        append_segment_with_crossfade(&mut out, &next);
        // Overlaps by 32 samples during crossfade: 100 + 100 - 32 = 168
        assert_eq!(out.len(), 168);
        // Verify crossfade smooth transition around index 68..100
        let val_at_boundary = out[84];
        assert!(val_at_boundary.abs() < 1000, "Expected smoothed transition");
    }

    #[tokio::test]
    async fn compact_speech_audio_handles_invalid_bytes_gracefully() {
        let fake_audio = vec![0xDE, 0xAD, 0xBE, 0xEF];
        let (out_bytes, out_fmt, out_dur) =
            compact_speech_audio(fake_audio.clone(), "m4a", Some(5.0)).await;
        assert_eq!(out_bytes, fake_audio);
        assert_eq!(out_fmt, "m4a");
        assert_eq!(out_dur, Some(5.0));
    }

    #[tokio::test]
    async fn compact_speech_audio_skips_when_savings_are_negligible() {
        // Continuous tone with no silence
        let mut samples = Vec::new();
        for i in 0..32000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16);
        }
        let wav_bytes = write_wav_16k_mono(&samples);
        let (out_bytes, out_fmt, _) =
            compact_speech_audio(wav_bytes.clone(), "wav", Some(2.0)).await;
        // When no pauses exist, original audio is returned
        assert_eq!(out_bytes, wav_bytes);
        assert_eq!(out_fmt, "wav");
    }

    #[tokio::test]
    async fn compact_speech_audio_end_to_end_wav() {
        let mut samples = Vec::new();
        samples.extend(vec![10i16; 32000]); // 2s silence
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16); // 1s tone
        }
        samples.extend(vec![10i16; 32000]); // 2s silence
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16); // 1s tone
        }
        samples.extend(vec![10i16; 32000]); // 2s silence

        let wav_bytes = write_wav_16k_mono(&samples);
        let (out_bytes, out_fmt, out_dur) =
            compact_speech_audio(wav_bytes.clone(), "wav", Some(8.0)).await;

        if detect_audio_tool().is_some() {
            // With afconvert or ffmpeg, it encodes to m4a (or compacted wav)
            assert!(out_bytes.len() < wav_bytes.len());
            let dur = out_dur.expect("Should have duration");
            assert!(dur < 5.0 && dur > 2.0);
            assert!(out_fmt == "m4a" || out_fmt == "wav");
        }
    }

    #[tokio::test]
    async fn compact_speech_audio_end_to_end_m4a() {
        let tool = match detect_audio_tool() {
            Some(t) => t,
            None => return,
        };

        // Create a WAV with silence + speech + silence
        let mut samples = Vec::new();
        samples.extend(vec![10i16; 32000]); // 2s silence
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16); // 1s tone
        }
        samples.extend(vec![10i16; 32000]); // 2s silence
        for i in 0..16000 {
            samples.push(((i as f32 * 0.2).sin() * 12000.0) as i16); // 1s tone
        }
        samples.extend(vec![10i16; 32000]); // 2s silence

        let wav_bytes = write_wav_16k_mono(&samples);
        let temp_dir = std::env::temp_dir();
        let session_id = Uuid::new_v4();
        let test_wav = temp_dir.join(format!("test-in-{session_id}.wav"));
        let test_m4a = temp_dir.join(format!("test-in-{session_id}.m4a"));
        let _g1 = TempFileGuard(test_wav.clone());
        let _g2 = TempFileGuard(test_m4a.clone());

        std::fs::write(&test_wav, &wav_bytes).unwrap();
        assert!(encode_wav_to_m4a(tool, &test_wav, &test_m4a));
        let m4a_bytes = std::fs::read(&test_m4a).unwrap();

        // Run through compact_speech_audio with format="m4a"
        let (out_bytes, out_fmt, out_dur) =
            compact_speech_audio(m4a_bytes.clone(), "m4a", Some(8.0)).await;

        assert_eq!(out_fmt, "m4a");
        assert!(!out_bytes.is_empty());
        let dur = out_dur.expect("Should have duration");
        assert!(dur < 5.0 && dur > 2.0);
    }
}
