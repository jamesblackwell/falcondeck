use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand::{RngCore, rngs::OsRng};
use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

use crate::{
    EncryptedEnvelope, EncryptionVariant, IdentityVariant, PairingPublicKeyBundle,
    SessionKeyMaterial, WrappedDataKey,
};

const AES_GCM_VERSION: u8 = 0;
const WRAPPED_KEY_VERSION: u8 = 0;
const AES_NONCE_LEN: usize = 12;
const AES_TAG_LEN: usize = 16;
const BOX_PUBKEY_LEN: usize = 32;
const BOX_NONCE_LEN: usize = 24;
const DATA_KEY_LEN: usize = 32;
const SIGNING_PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("unsupported encryption variant")]
    UnsupportedVariant,
    #[error("invalid base64 payload")]
    InvalidBase64,
    #[error("invalid key material")]
    InvalidKeyMaterial,
    #[error("invalid encrypted envelope")]
    InvalidEnvelope,
    #[error("invalid signature")]
    InvalidSignature,
    #[error("failed to encrypt payload")]
    EncryptFailed,
    #[error("failed to decrypt payload")]
    DecryptFailed,
    #[error("failed to serialize payload")]
    SerializeFailed,
    #[error("failed to deserialize payload")]
    DeserializeFailed,
}

#[derive(Debug, Clone)]
pub struct LocalBoxKeyPair {
    secret_key: SecretKey,
    public_key_base64: String,
}

#[derive(Debug, Clone)]
pub struct LocalIdentityKeyPair {
    signing_key: SigningKey,
    public_key_base64: String,
}

impl LocalIdentityKeyPair {
    pub fn from_seed(seed: &[u8; DATA_KEY_LEN]) -> Self {
        let signing_key = SigningKey::from_bytes(seed);
        let public_key_base64 = BASE64.encode(signing_key.verifying_key().as_bytes());
        Self {
            signing_key,
            public_key_base64,
        }
    }

    pub fn from_box_key_pair(key_pair: &LocalBoxKeyPair) -> Self {
        Self::from_seed(&key_pair.secret_key_bytes())
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn sign_bytes(&self, payload: &[u8]) -> String {
        BASE64.encode(self.signing_key.sign(payload).to_bytes())
    }
}

impl LocalBoxKeyPair {
    pub fn generate() -> Self {
        let secret_key = SecretKey::generate(&mut OsRng);
        let public_key_base64 = BASE64.encode(secret_key.public_key().as_bytes());
        Self {
            secret_key,
            public_key_base64,
        }
    }

    pub fn public_key_base64(&self) -> &str {
        &self.public_key_base64
    }

    pub fn wrap_data_key(
        &self,
        recipient_public_key_base64: &str,
        data_key: &[u8; DATA_KEY_LEN],
    ) -> Result<WrappedDataKey, CryptoError> {
        let recipient_public_key = decode_public_key(recipient_public_key_base64)?;
        let ephemeral_secret = SecretKey::generate(&mut OsRng);
        let ephemeral_public = ephemeral_secret.public_key();
        let cipher = SalsaBox::new(&recipient_public_key, &ephemeral_secret);
        let mut nonce_bytes = [0u8; BOX_NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = crypto_box::aead::generic_array::GenericArray::clone_from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(&nonce, data_key.as_slice())
            .map_err(|_| CryptoError::EncryptFailed)?;

        let mut bundle = Vec::with_capacity(1 + BOX_PUBKEY_LEN + BOX_NONCE_LEN + ciphertext.len());
        bundle.push(WRAPPED_KEY_VERSION);
        bundle.extend_from_slice(ephemeral_public.as_bytes());
        bundle.extend_from_slice(&nonce_bytes);
        bundle.extend_from_slice(&ciphertext);

        Ok(WrappedDataKey {
            encryption_variant: EncryptionVariant::DataKeyV1,
            wrapped_key: BASE64.encode(bundle),
        })
    }

    pub fn unwrap_data_key(
        &self,
        wrapped: &WrappedDataKey,
    ) -> Result<[u8; DATA_KEY_LEN], CryptoError> {
        if wrapped.encryption_variant != EncryptionVariant::DataKeyV1 {
            return Err(CryptoError::UnsupportedVariant);
        }
        let bundle = BASE64
            .decode(&wrapped.wrapped_key)
            .map_err(|_| CryptoError::InvalidBase64)?;
        if bundle.len() < 1 + BOX_PUBKEY_LEN + BOX_NONCE_LEN {
            return Err(CryptoError::InvalidEnvelope);
        }
        if bundle[0] != WRAPPED_KEY_VERSION {
            return Err(CryptoError::UnsupportedVariant);
        }

        let ephemeral_public = PublicKey::from(
            <[u8; BOX_PUBKEY_LEN]>::try_from(&bundle[1..1 + BOX_PUBKEY_LEN])
                .map_err(|_| CryptoError::InvalidKeyMaterial)?,
        );
        let nonce_start = 1 + BOX_PUBKEY_LEN;
        let nonce_end = nonce_start + BOX_NONCE_LEN;
        let nonce = crypto_box::aead::generic_array::GenericArray::clone_from_slice(
            &bundle[nonce_start..nonce_end],
        );
        let ciphertext = &bundle[nonce_end..];
        let cipher = SalsaBox::new(&ephemeral_public, &self.secret_key);
        let plaintext = cipher
            .decrypt(&nonce, ciphertext)
            .map_err(|_| CryptoError::DecryptFailed)?;
        <[u8; DATA_KEY_LEN]>::try_from(plaintext.as_slice())
            .map_err(|_| CryptoError::InvalidKeyMaterial)
    }

    pub fn secret_key_bytes(&self) -> [u8; DATA_KEY_LEN] {
        self.secret_key.to_bytes()
    }

    pub fn secret_key_base64(&self) -> String {
        BASE64.encode(self.secret_key.to_bytes())
    }

    pub fn from_secret_key_base64(secret_key_base64: &str) -> Result<Self, CryptoError> {
        let bytes = BASE64
            .decode(secret_key_base64)
            .map_err(|_| CryptoError::InvalidBase64)?;
        let secret_key_bytes = <[u8; DATA_KEY_LEN]>::try_from(bytes.as_slice())
            .map_err(|_| CryptoError::InvalidKeyMaterial)?;
        let secret_key = SecretKey::from(secret_key_bytes);
        let public_key_base64 = BASE64.encode(secret_key.public_key().as_bytes());
        Ok(Self {
            secret_key,
            public_key_base64,
        })
    }
}

pub fn generate_data_key() -> [u8; DATA_KEY_LEN] {
    let mut data_key = [0u8; DATA_KEY_LEN];
    OsRng.fill_bytes(&mut data_key);
    data_key
}

fn decode_public_key(public_key_base64: &str) -> Result<PublicKey, CryptoError> {
    let bytes = BASE64
        .decode(public_key_base64)
        .map_err(|_| CryptoError::InvalidBase64)?;
    let key_bytes = <[u8; BOX_PUBKEY_LEN]>::try_from(bytes.as_slice())
        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
    Ok(PublicKey::from(key_bytes))
}

fn decode_signing_public_key(public_key_base64: &str) -> Result<VerifyingKey, CryptoError> {
    let bytes = BASE64
        .decode(public_key_base64)
        .map_err(|_| CryptoError::InvalidBase64)?;
    let key_bytes = <[u8; SIGNING_PUBKEY_LEN]>::try_from(bytes.as_slice())
        .map_err(|_| CryptoError::InvalidKeyMaterial)?;
    VerifyingKey::from_bytes(&key_bytes).map_err(|_| CryptoError::InvalidKeyMaterial)
}

fn decode_signature(signature_base64: &str) -> Result<Signature, CryptoError> {
    let bytes = BASE64
        .decode(signature_base64)
        .map_err(|_| CryptoError::InvalidBase64)?;
    let signature_bytes = <[u8; SIGNATURE_LEN]>::try_from(bytes.as_slice())
        .map_err(|_| CryptoError::InvalidSignature)?;
    Ok(Signature::from_bytes(&signature_bytes))
}

fn pairing_bundle_signing_payload(bundle: &PairingPublicKeyBundle) -> Vec<u8> {
    format!(
        "falcondeck-pairing-bundle-v1\ndata_key_v1\ned25519_v1\n{}\n{}",
        bundle.public_key, bundle.identity_public_key
    )
    .into_bytes()
}

fn session_key_material_signing_payload(material: &SessionKeyMaterial) -> Vec<u8> {
    format!(
        "falcondeck-session-bootstrap-v1\ndata_key_v1\ned25519_v1\n{}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        material.pairing_id,
        material.session_id,
        material.daemon_public_key,
        material.daemon_identity_public_key,
        material.client_public_key,
        material.client_identity_public_key,
        material.client_wrapped_data_key.wrapped_key,
        material
            .daemon_wrapped_data_key
            .as_ref()
            .map(|wrapped| wrapped.wrapped_key.as_str())
            .unwrap_or("")
    )
    .into_bytes()
}

pub fn build_pairing_public_key_bundle(key_pair: &LocalBoxKeyPair) -> PairingPublicKeyBundle {
    let identity_key_pair = LocalIdentityKeyPair::from_box_key_pair(key_pair);
    let mut bundle = PairingPublicKeyBundle {
        encryption_variant: EncryptionVariant::DataKeyV1,
        identity_variant: IdentityVariant::Ed25519V1,
        public_key: key_pair.public_key_base64().to_string(),
        identity_public_key: identity_key_pair.public_key_base64().to_string(),
        signature: String::new(),
    };
    bundle.signature = identity_key_pair.sign_bytes(&pairing_bundle_signing_payload(&bundle));
    bundle
}

pub fn verify_pairing_public_key_bundle(
    bundle: &PairingPublicKeyBundle,
) -> Result<(), CryptoError> {
    if bundle.encryption_variant != EncryptionVariant::DataKeyV1
        || bundle.identity_variant != IdentityVariant::Ed25519V1
        || bundle.public_key.is_empty()
        || bundle.identity_public_key.is_empty()
        || bundle.signature.is_empty()
    {
        return Err(CryptoError::InvalidSignature);
    }
    let public_key = decode_signing_public_key(&bundle.identity_public_key)?;
    let signature = decode_signature(&bundle.signature)?;
    public_key
        .verify(&pairing_bundle_signing_payload(bundle), &signature)
        .map_err(|_| CryptoError::InvalidSignature)
}

pub fn sign_session_key_material(
    identity_key_pair: &LocalIdentityKeyPair,
    material: &mut SessionKeyMaterial,
) -> Result<(), CryptoError> {
    if material.identity_variant != IdentityVariant::Ed25519V1 {
        return Err(CryptoError::UnsupportedVariant);
    }
    material.signature =
        identity_key_pair.sign_bytes(&session_key_material_signing_payload(material));
    Ok(())
}

pub fn verify_session_key_material(material: &SessionKeyMaterial) -> Result<(), CryptoError> {
    if material.encryption_variant != EncryptionVariant::DataKeyV1
        || material.identity_variant != IdentityVariant::Ed25519V1
        || material.pairing_id.is_empty()
        || material.session_id.is_empty()
        || material.daemon_public_key.is_empty()
        || material.daemon_identity_public_key.is_empty()
        || material.client_public_key.is_empty()
        || material.client_identity_public_key.is_empty()
        || material.signature.is_empty()
    {
        return Err(CryptoError::InvalidSignature);
    }
    let public_key = decode_signing_public_key(&material.daemon_identity_public_key)?;
    let signature = decode_signature(&material.signature)?;
    public_key
        .verify(&session_key_material_signing_payload(material), &signature)
        .map_err(|_| CryptoError::InvalidSignature)
}

pub fn encrypt_bytes(
    data_key: &[u8; DATA_KEY_LEN],
    bytes: &[u8],
) -> Result<EncryptedEnvelope, CryptoError> {
    let cipher =
        Aes256Gcm::new_from_slice(data_key).map_err(|_| CryptoError::InvalidKeyMaterial)?;
    let mut nonce_bytes = [0u8; AES_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, bytes)
        .map_err(|_| CryptoError::EncryptFailed)?;

    let mut bundle = Vec::with_capacity(1 + AES_NONCE_LEN + ciphertext.len());
    bundle.push(AES_GCM_VERSION);
    bundle.extend_from_slice(&nonce_bytes);
    bundle.extend_from_slice(&ciphertext);

    Ok(EncryptedEnvelope {
        encryption_variant: EncryptionVariant::DataKeyV1,
        ciphertext: BASE64.encode(bundle),
    })
}

pub fn decrypt_bytes(
    data_key: &[u8; DATA_KEY_LEN],
    envelope: &EncryptedEnvelope,
) -> Result<Vec<u8>, CryptoError> {
    if envelope.encryption_variant != EncryptionVariant::DataKeyV1 {
        return Err(CryptoError::UnsupportedVariant);
    }
    let bundle = BASE64
        .decode(&envelope.ciphertext)
        .map_err(|_| CryptoError::InvalidBase64)?;
    if bundle.len() < 1 + AES_NONCE_LEN + AES_TAG_LEN {
        return Err(CryptoError::InvalidEnvelope);
    }
    if bundle[0] != AES_GCM_VERSION {
        return Err(CryptoError::UnsupportedVariant);
    }

    let cipher =
        Aes256Gcm::new_from_slice(data_key).map_err(|_| CryptoError::InvalidKeyMaterial)?;
    let nonce = Nonce::from_slice(&bundle[1..1 + AES_NONCE_LEN]);
    let ciphertext = &bundle[1 + AES_NONCE_LEN..];
    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|_| CryptoError::DecryptFailed)
}

pub fn encrypt_json<T: Serialize>(
    data_key: &[u8; DATA_KEY_LEN],
    value: &T,
) -> Result<EncryptedEnvelope, CryptoError> {
    let payload = serde_json::to_vec(value).map_err(|_| CryptoError::SerializeFailed)?;
    encrypt_bytes(data_key, &payload)
}

pub fn decrypt_json<T: DeserializeOwned>(
    data_key: &[u8; DATA_KEY_LEN],
    envelope: &EncryptedEnvelope,
) -> Result<T, CryptoError> {
    let bytes = decrypt_bytes(data_key, envelope)?;
    serde_json::from_slice(&bytes).map_err(|_| CryptoError::DeserializeFailed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aes_gcm_round_trip() {
        let key = generate_data_key();
        let envelope = encrypt_json(&key, &json!({ "hello": "world" })).unwrap();
        let value: serde_json::Value = decrypt_json(&key, &envelope).unwrap();
        assert_eq!(value["hello"], "world");
    }

    #[test]
    fn tampered_envelope_is_rejected() {
        let key = generate_data_key();
        let mut envelope = encrypt_json(&key, &json!({ "hello": "world" })).unwrap();
        let mut raw = BASE64.decode(&envelope.ciphertext).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        envelope.ciphertext = BASE64.encode(raw);
        assert!(decrypt_json::<serde_json::Value>(&key, &envelope).is_err());
    }

    #[test]
    fn wrapped_data_key_round_trip() {
        let _daemon = LocalBoxKeyPair::generate();
        let client = LocalBoxKeyPair::generate();
        let data_key = generate_data_key();
        let wrapped = {
            let recipient_public_key = client.public_key_base64();
            let ephemeral_secret = SecretKey::generate(&mut OsRng);
            let ephemeral_public = ephemeral_secret.public_key();
            let cipher = SalsaBox::new(
                &decode_public_key(recipient_public_key).unwrap(),
                &ephemeral_secret,
            );
            let mut nonce_bytes = [0u8; BOX_NONCE_LEN];
            OsRng.fill_bytes(&mut nonce_bytes);
            let nonce =
                crypto_box::aead::generic_array::GenericArray::clone_from_slice(&nonce_bytes);
            let ciphertext = cipher.encrypt(&nonce, data_key.as_slice()).unwrap();
            let mut bundle = Vec::new();
            bundle.push(WRAPPED_KEY_VERSION);
            bundle.extend_from_slice(ephemeral_public.as_bytes());
            bundle.extend_from_slice(&nonce_bytes);
            bundle.extend_from_slice(&ciphertext);
            WrappedDataKey {
                encryption_variant: EncryptionVariant::DataKeyV1,
                wrapped_key: BASE64.encode(bundle),
            }
        };
        let unwrapped = client.unwrap_data_key(&wrapped).unwrap();
        assert_eq!(unwrapped, data_key);
    }

    #[test]
    fn local_key_pair_restores_from_secret_key_base64() {
        let key_pair = LocalBoxKeyPair::generate();
        let restored =
            LocalBoxKeyPair::from_secret_key_base64(&key_pair.secret_key_base64()).unwrap();
        assert_eq!(restored.public_key_base64(), key_pair.public_key_base64());
        assert_eq!(restored.secret_key_bytes(), key_pair.secret_key_bytes());
    }

    #[test]
    fn pairing_bundle_signature_round_trip() {
        let key_pair = LocalBoxKeyPair::generate();
        let bundle = build_pairing_public_key_bundle(&key_pair);
        verify_pairing_public_key_bundle(&bundle).unwrap();
    }

    #[test]
    fn tampered_pairing_bundle_signature_is_rejected() {
        let key_pair = LocalBoxKeyPair::generate();
        let mut bundle = build_pairing_public_key_bundle(&key_pair);
        bundle.public_key = LocalBoxKeyPair::generate().public_key_base64().to_string();
        assert!(verify_pairing_public_key_bundle(&bundle).is_err());
    }

    #[test]
    fn session_bootstrap_signature_round_trip() {
        let daemon = LocalBoxKeyPair::generate();
        let client = LocalBoxKeyPair::generate();
        let data_key = generate_data_key();
        let mut material = SessionKeyMaterial {
            encryption_variant: EncryptionVariant::DataKeyV1,
            identity_variant: IdentityVariant::Ed25519V1,
            pairing_id: "pairing-1".to_string(),
            session_id: "session-1".to_string(),
            daemon_public_key: daemon.public_key_base64().to_string(),
            daemon_identity_public_key: LocalIdentityKeyPair::from_box_key_pair(&daemon)
                .public_key_base64()
                .to_string(),
            client_public_key: client.public_key_base64().to_string(),
            client_identity_public_key: LocalIdentityKeyPair::from_box_key_pair(&client)
                .public_key_base64()
                .to_string(),
            client_wrapped_data_key: daemon
                .wrap_data_key(client.public_key_base64(), &data_key)
                .unwrap(),
            daemon_wrapped_data_key: Some(
                daemon
                    .wrap_data_key(daemon.public_key_base64(), &data_key)
                    .unwrap(),
            ),
            signature: String::new(),
        };
        sign_session_key_material(
            &LocalIdentityKeyPair::from_box_key_pair(&daemon),
            &mut material,
        )
        .unwrap();
        verify_session_key_material(&material).unwrap();
    }
}
