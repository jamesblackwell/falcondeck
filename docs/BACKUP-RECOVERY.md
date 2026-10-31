# Recovery backups

The native Mac app’s **Settings → Backup & data → Encrypted recovery backup**
creates `.fdbackup` files. Choose a folder in iCloud Drive or another backed-up
location, enter and confirm a recovery password, then use **Back up now**.
Keep the password in a password manager accessible without the original Mac.
FalconDeck reports a successful local write; the sync provider controls cloud
upload. Check that the file is available from another device.

Daily backups run while the Mac app is open and connected. A missed daily backup
is attempted on the next launch; failures retry hourly and appear in Settings.
The password for daily backups is stored in this Mac’s Keychain, never preferences.
Changing the password for a manual backup also updates the daily password when
scheduling is enabled. Older archives still need their original passwords.
Backups are retained; there is no automatic deletion in this first version.

## Contents

- Every supported Claude or Codex bot’s native JSONL session, including selected
  Claude session auxiliary files and the project’s auto-memory directory.
- Bot document spaces, including nested files, and attached external context
  files. External copies become managed files on restore.
- Managed `bots`, `context`, `attachments`, `artifacts`, `skills`, `tickets` and
  `extensions` directories.
- Daemon project metadata, preferences, extension storage, automation definitions,
  connector configuration, provider configuration and native appearance settings.
  Connector configuration can contain secrets and is encrypted with the archive.

Agent credentials, remote pairings, OAuth token stores, databases, runtime caches,
logs, binaries, repository checkouts and ordinary task transcripts are excluded.
The database indexes for native sessions are rebuilt by the harness. Unsupported
bot harnesses and missing native sessions fail the entire backup instead of
silently producing incomplete recovery. Symbolic links are rejected for captured
managed files. A running bot makes backup wait for the next attempt. Each archive
is limited to 256 MiB of decoded contents and 20,000 files.

## Restore

Install FalconDeck on the replacement Mac and open Settings before adding projects
or bots. Enter the recovery password and open the `.fdbackup` file. Review its bot
and file counts, then choose **Restore on next launch**. Quit and reopen FalconDeck.

The daemon applies recovery under its exclusive state lock before loading
providers, schedulers or extensions. Paths under the old home and daemon directory
are relocated. Promoted bots whose project checkouts are outside FalconDeck receive
an empty managed working directory; recover their repositories separately. Bot
sessions and documents remain available. Automation definitions are restored
paused, and agent control is disabled until reviewed. Sign in to agents, pair devices
again, and restore missing repositories before resuming work.

Only a fresh installation can receive a recovery. Existing native files are never
silently merged or overwritten during initial preflight. Interrupted application
is replayed on the next launch using an owner-only progress marker and atomic file
replacements. The pending plaintext transport lives with mode 0600 inside the
local daemon state directory and is removed after successful application. An
invalid staged restore fails startup rather than continuing with partial state.

## Format and boundaries

Version 1 starts with `FDRECOVERY1\n`, a 32-byte random salt, and a CryptoKit
AES-256-GCM combined nonce/ciphertext/tag. The key uses PBKDF2-HMAC-SHA256 with
600,000 iterations. The header and salt are authenticated. Plaintext contains a
versioned `RecoveryArchive` manifest and base64 file contents. Encryption happens
in memory before the first local or cloud destination write.

Local HTTP `GET /api/recovery` exports the sensitive plaintext transport.
`POST /api/recovery/stage` validates it and stages startup recovery. These are
local daemon endpoints, with the daemon’s loopback/origin protections, and are
not registered as remote RPCs or agent tools. Native conversation history remains
owned by the harness; the archive is a backup transport, not a new conversation DB.

The older JSON settings export is separate and does not include native bot
sessions or document files. It is not a disaster-recovery archive.
