use serde_json::{Map, Value, json};

use crate::error::DaemonError;

/// Convert the existing question UI's ordered string answers to OpenCode's
/// typed, keyed form reply. Read the authoritative form again before replying.
pub(super) fn form_answers(form: &Value, answers: &[Vec<String>]) -> Result<Value, DaemonError> {
    let fields = form
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| DaemonError::Rpc("OpenCode form did not contain fields".to_string()))?;
    let mut values = Map::new();
    let mut answers = answers.iter();
    for field in fields {
        let key = field.get("key").and_then(Value::as_str).ok_or_else(|| {
            DaemonError::Rpc("OpenCode form field did not contain a key".to_string())
        })?;
        let hidden = field["hidden"].as_bool().unwrap_or(false);
        let selected = if hidden { None } else { answers.next() };
        let active = field
            .get("when")
            .and_then(Value::as_array)
            .is_none_or(|conditions| {
                conditions.iter().all(|condition| {
                    let Some(value) = condition["key"].as_str().and_then(|key| values.get(key))
                    else {
                        return false;
                    };
                    let matches = match value {
                        Value::Array(values) => values.contains(&condition["value"]),
                        value if value.is_number() && condition["value"].is_number() => {
                            value.as_f64() == condition["value"].as_f64()
                        }
                        value => value == &condition["value"],
                    };
                    if condition["op"] == "ne" {
                        !matches
                    } else {
                        matches
                    }
                })
            });
        if !active {
            continue;
        }
        let Some(selected) = selected.filter(|values| !values.is_empty()) else {
            if let Some(default) = field.get("default") {
                values.insert(key.to_string(), default.clone());
            }
            continue;
        };
        let selected = selected
            .iter()
            .flat_map(|answer| {
                let exact_option =
                    field
                        .get("options")
                        .and_then(Value::as_array)
                        .is_some_and(|options| {
                            options.iter().any(|option| {
                                option["label"].as_str() == Some(answer)
                                    || option["value"].as_str() == Some(answer)
                            })
                        });
                if field["type"] == "multiselect" && !exact_option {
                    answer
                        .split([',', '\n'])
                        .map(str::trim)
                        .filter(|part| !part.is_empty())
                        .collect::<Vec<_>>()
                } else {
                    vec![answer.as_str()]
                }
            })
            .collect::<Vec<_>>();
        let mapped = selected
            .iter()
            .map(|answer| {
                field
                    .get("options")
                    .and_then(Value::as_array)
                    .and_then(|options| {
                        options
                            .iter()
                            .find(|option| option["label"].as_str() == Some(*answer))
                    })
                    .and_then(|option| option["value"].as_str())
                    .unwrap_or(answer)
                    .to_string()
            })
            .collect::<Vec<_>>();
        let invalid =
            || DaemonError::BadRequest(format!("Invalid answer for OpenCode form field '{key}'"));
        let value = match field["type"].as_str() {
            Some("multiselect") => json!(mapped),
            Some("string") if mapped.len() == 1 => json!(mapped[0]),
            Some("number" | "integer") if mapped.len() == 1 => {
                let number: Value =
                    serde_json::from_str(mapped[0].trim()).map_err(|_| invalid())?;
                if !number.is_number()
                    || (field["type"] == "integer"
                        && !number.as_f64().is_some_and(|value| value.fract() == 0.0))
                {
                    return Err(invalid());
                }
                number
            }
            Some("boolean") if mapped.len() == 1 => match mapped[0].to_ascii_lowercase().as_str() {
                "true" | "yes" => json!(true),
                "false" | "no" => json!(false),
                _ => return Err(invalid()),
            },
            Some("external") if mapped.as_slice() == ["Continue"] => json!(true),
            _ => return Err(invalid()),
        };
        values.insert(key.to_string(), value);
    }
    Ok(Value::Object(values))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replies_keep_field_keys_types_and_option_values() {
        let form = json!({"fields":[
            {"key":"choice","type":"string","options":[{"label":"Friendly","value":"internal"}]},
            {"key":"tags","type":"multiselect","options":[{"label":"One","value":"one"}]},
            {"key":"count","type":"integer"}, {"key":"enabled","type":"boolean"},
            {"key":"hidden","type":"string","hidden":true,"default":"kept"}
        ]});
        assert_eq!(
            form_answers(
                &form,
                &[
                    vec!["Friendly".into()],
                    vec!["One".into()],
                    vec!["3".into()],
                    vec!["False".into()]
                ]
            )
            .unwrap(),
            json!({"choice":"internal","tags":["one"],"count":3,"enabled":false,"hidden":"kept"})
        );
    }

    #[test]
    fn inactive_fields_are_omitted_and_invalid_types_are_rejected() {
        let form = json!({"fields":[{"key":"enabled","type":"boolean"},
            {"key":"dependent","type":"string","when":[{"key":"enabled","op":"eq","value":true}]}]});
        assert_eq!(
            form_answers(&form, &[vec!["false".into()], vec!["unused".into()]]).unwrap(),
            json!({"enabled":false})
        );
        assert!(form_answers(&form, &[vec!["maybe".into()]]).is_err());
        assert!(
            form_answers(
                &json!({"fields":[{"key":"count","type":"integer"}]}),
                &[vec!["1.5".into()]]
            )
            .is_err()
        );
    }

    #[test]
    fn numeric_conditions_follow_javascript_number_equality() {
        let form = json!({"fields":[
            {"key":"count","type":"number"},
            {"key":"dependent","type":"string","when":[{"key":"count","op":"eq","value":3}]}
        ]});
        assert_eq!(
            form_answers(&form, &[vec!["3.0".into()], vec!["kept".into()]]).unwrap(),
            json!({"count":3.0,"dependent":"kept"})
        );
        assert!(
            form_answers(
                &json!({"fields":[{"key":"count","type":"integer"}]}),
                &[vec!["3.0".into()]]
            )
            .is_ok()
        );
    }

    #[test]
    fn multiline_or_comma_choices_work_with_the_existing_question_ui() {
        let form = json!({"fields":[{"key":"tags","type":"multiselect","options":[
            {"label":"One","value":"one"},{"label":"Two","value":"two"},
            {"label":"Three, four","value":"three-four"}
        ]}]});
        assert_eq!(
            form_answers(&form, &[vec!["One, Two".into()]]).unwrap(),
            json!({"tags":["one","two"]})
        );
        assert_eq!(
            form_answers(&form, &[vec!["One\nTwo".into()]]).unwrap(),
            json!({"tags":["one","two"]})
        );
        assert_eq!(
            form_answers(&form, &[vec!["Three, four".into()]]).unwrap(),
            json!({"tags":["three-four"]})
        );
    }
}
