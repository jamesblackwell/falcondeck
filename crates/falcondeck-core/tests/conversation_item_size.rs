use std::mem::size_of;

use falcondeck_core::ConversationItem;

#[test]
fn conversation_item_stays_compact_for_long_thread_storage() {
    let size = size_of::<ConversationItem>();
    assert!(
        size <= 256,
        "ConversationItem grew to {size} bytes; box unusually large variant fields"
    );
}
