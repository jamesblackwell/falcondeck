//! The transcript fields search uses, without copying unrelated tool payloads.

use std::{borrow::Cow, fmt};

use serde::{
    Deserialize, Deserializer,
    de::{Error, MapAccess, SeqAccess, Visitor},
};

/// Unescaped strings borrow the JSONL line until message extraction completes.
/// Numbers and null remain distinguishable from a missing object field, but
/// neither carries data that user-message extraction needs.
#[derive(Debug)]
pub(super) enum MessageValue<'a> {
    String(Cow<'a, str>),
    Bool(bool),
    Array(Vec<Self>),
    Object(Vec<(&'static str, Self)>),
    Other,
}

impl MessageValue<'_> {
    pub(super) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields
                .iter()
                .find(|(field, _)| *field == key)
                .map(|(_, value)| value),
            _ => None,
        }
    }

    pub(super) fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text.as_ref()),
            _ => None,
        }
    }

    pub(super) fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub(super) fn as_array(&self) -> Option<&Vec<Self>> {
        match self {
            Self::Array(values) => Some(values),
            _ => None,
        }
    }
}

/// Object keys are decoded and compared without retaining their allocations.
/// Escaped keys must still match (for example, `ty\u0070e` means `type`).
struct MessageKey(Option<&'static str>);

impl<'de> Deserialize<'de> for MessageKey {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;

        impl Visitor<'_> for KeyVisitor {
            type Value = MessageKey;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON object key")
            }

            fn visit_str<E: Error>(self, key: &str) -> Result<Self::Value, E> {
                Ok(MessageKey(match key {
                    "type" => Some("type"),
                    "role" => Some("role"),
                    "message" => Some("message"),
                    "payload" => Some("payload"),
                    "content" => Some("content"),
                    "text" => Some("text"),
                    "isSidechain" => Some("isSidechain"),
                    "isMeta" => Some("isMeta"),
                    _ => None,
                }))
            }
        }

        deserializer.deserialize_str(KeyVisitor)
    }
}

impl<'de> Deserialize<'de> for MessageValue<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MessageVisitor;

        impl<'de> Visitor<'de> for MessageVisitor {
            type Value = MessageValue<'de>;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a JSON value")
            }

            fn visit_borrowed_str<E: Error>(self, text: &'de str) -> Result<Self::Value, E> {
                Ok(MessageValue::String(Cow::Borrowed(text)))
            }

            fn visit_str<E: Error>(self, text: &str) -> Result<Self::Value, E> {
                Ok(MessageValue::String(Cow::Owned(text.to_owned())))
            }

            fn visit_bool<E: Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(MessageValue::Bool(value))
            }

            fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
                Ok(MessageValue::Other)
            }

            fn visit_i64<E: Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(MessageValue::Other)
            }

            fn visit_u64<E: Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(MessageValue::Other)
            }

            fn visit_f64<E: Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(MessageValue::Other)
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(MessageValue::Array(values))
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut fields: Vec<(&'static str, MessageValue<'de>)> = Vec::new();
                while let Some(MessageKey(key)) = map.next_key()? {
                    let Some(key) = key else {
                        map.next_value::<DiscardValue>()?;
                        continue;
                    };
                    let value = map.next_value()?;
                    // serde_json::Value keeps the last occurrence of a key.
                    if let Some((_, previous)) = fields.iter_mut().find(|(field, _)| *field == key)
                    {
                        *previous = value;
                    } else {
                        fields.push((key, value));
                    }
                }
                Ok(MessageValue::Object(fields))
            }
        }

        deserializer.deserialize_any(MessageVisitor)
    }
}

/// `IgnoredAny` bypasses validation that `Value` performs: out-of-range
/// numbers, lone Unicode surrogates and excessive nesting can be accepted.
/// Walk unknown values normally, retaining nothing, to preserve that boundary.
struct DiscardValue;

impl<'de> Deserialize<'de> for DiscardValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DiscardVisitor;

        impl<'de> Visitor<'de> for DiscardVisitor {
            type Value = DiscardValue;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a valid JSON value")
            }

            fn visit_str<E: Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_bool<E: Error>(self, _: bool) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_unit<E: Error>(self) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_i64<E: Error>(self, _: i64) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_u64<E: Error>(self, _: u64) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_f64<E: Error>(self, _: f64) -> Result<Self::Value, E> {
                Ok(DiscardValue)
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                while sequence.next_element::<DiscardValue>()?.is_some() {}
                Ok(DiscardValue)
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_key::<MessageKey>()?.is_some() {
                    map.next_value::<DiscardValue>()?;
                }
                Ok(DiscardValue)
            }
        }

        deserializer.deserialize_any(DiscardVisitor)
    }
}

#[cfg(test)]
#[path = "message_parser_tests.rs"]
mod tests;
