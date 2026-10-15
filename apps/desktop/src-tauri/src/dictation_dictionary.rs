use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Correction {
    pub find: String,
    pub replace: String,
}

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("dictation-dictionary.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dictation_dictionary(app: AppHandle) -> Result<Vec<Correction>, String> {
    let path = path(&app)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("Could not read the correction dictionary: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("Could not read the correction dictionary: {e}")),
    }
}

#[tauri::command]
pub fn save_dictation_dictionary(app: AppHandle, entries: Vec<Correction>) -> Result<(), String> {
    let entries = validate(entries)?;
    let _guard = WRITE_LOCK
        .lock()
        .map_err(|_| "Dictionary storage is unavailable.")?;
    let path = path(&app)?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let pending = path.with_extension("json.pending");
    let bytes = serde_json::to_vec_pretty(&entries).map_err(|e| e.to_string())?;
    std::fs::write(&pending, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(pending, path).map_err(|e| e.to_string())
}

fn validate(entries: Vec<Correction>) -> Result<Vec<Correction>, String> {
    if entries.len() > 100 {
        return Err("The dictionary can contain up to 100 corrections.".into());
    }
    let mut result: Vec<Correction> = Vec::new();
    for entry in entries {
        let find = entry.find.trim().to_string();
        let replace = entry.replace.trim().to_string();
        if find.is_empty()
            || find.chars().count() > 200
            || replace.chars().count() > 200
            || find.contains('\0')
            || replace.contains('\0')
        {
            return Err("Each correction needs a word or phrase to find, up to 200 characters per field. Leave the replacement blank to remove it.".into());
        }
        if result
            .iter()
            .any(|e| e.find.to_lowercase() == find.to_lowercase())
        {
            return Err(format!("A correction for {find} already exists."));
        }
        result.push(Correction { find, replace });
    }
    Ok(result)
}

pub fn apply(app: &AppHandle, text: String) -> String {
    match dictation_dictionary(app.clone()).and_then(validate) {
        Ok(entries) => replace(&text, &entries),
        Err(_) => text,
    }
}

fn word(character: char) -> bool {
    character.is_alphanumeric() || character == '_'
}

// Match the original text once, longest phrases first. Replacement text never
// feeds back into the dictionary, and substrings inside other words stay intact.
fn replace(text: &str, entries: &[Correction]) -> String {
    let mut entries: Vec<_> = entries.iter().collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.find.chars().count()));
    let mut output = String::with_capacity(text.len());
    let mut position = 0;
    while position < text.len() {
        let remaining = &text[position..];
        let matched = entries.iter().find_map(|entry| {
            let count = entry.find.chars().count();
            let end = remaining
                .char_indices()
                .nth(count)
                .map_or(remaining.len(), |(index, _)| index);
            let candidate = &remaining[..end];
            if candidate.to_lowercase() != entry.find.to_lowercase() {
                return None;
            }
            let starts_word = entry.find.chars().next().is_some_and(word);
            let ends_word = entry.find.chars().last().is_some_and(word);
            if starts_word && text[..position].chars().next_back().is_some_and(word) {
                return None;
            }
            if ends_word && remaining[end..].chars().next().is_some_and(word) {
                return None;
            }
            Some((end, &entry.replace))
        });
        if let Some((length, replacement)) = matched {
            output.push_str(replacement);
            position += length;
        } else {
            let character = remaining.chars().next().unwrap();
            output.push(character);
            position += character.len_utf8();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(find: &str, replace: &str) -> Correction {
        Correction {
            find: find.into(),
            replace: replace.into(),
        }
    }
    #[test]
    fn replaces_names_and_phrases_without_cascades_or_partial_words() {
        let entries = vec![
            entry("larab", "Laravel"),
            entry("Laravel", "wrong"),
            entry("john", "Jon"),
            entry("john smith", "John Smyth"),
            entry("élodie", "Élodie"),
        ];
        assert_eq!(
            replace(
                "LARAB, larab's larabian; John Smith and JOHN. élodie.",
                &entries
            ),
            "Laravel, Laravel's larabian; John Smyth and Jon. Élodie."
        );
    }
    #[test]
    fn blank_replacements_remove_whole_words() {
        let entries = validate(vec![entry(" um ", "  ")]).unwrap();
        assert_eq!(entries[0].replace, "");
        assert_eq!(replace("UM", &entries), "");
        assert_eq!(replace("um hello um", &entries), " hello ");
        assert_eq!(replace("umbrella number", &entries), "umbrella number");
    }

    #[test]
    fn rejects_duplicates_and_invalid_entries() {
        assert!(validate(vec![entry("Larab", "Laravel"), entry("larab", "Laravel")]).is_err());
        assert!(validate(vec![entry(" ", "name")]).is_err());
        assert!(validate(vec![entry("a", "\0")]).is_err());
        assert_eq!(
            validate(vec![entry(" larab ", " Laravel ")]).unwrap()[0].find,
            "larab"
        );
    }
}
