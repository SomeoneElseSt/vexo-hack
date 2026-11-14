"""Device-held key for signing and encrypting your own medical records.

The key never leaves your device. The server (the VM) only ever stores
ciphertext, so reading the dashboard code or the deployment gains nothing:
without the key the data cannot be decrypted or forged.

Scheme (all primitives exist in WebCrypto too, so the browser can unlock):
    secret     32 random bytes, kept in my-project/.device_key (gitignored)
    device_id  base32(sha256(secret))[:16]
    auth       HMAC-SHA256(secret, "vexo-auth/v1")        bearer proof to the server
    enc key    HKDF-SHA256(secret, salt="vexo-records/v1", info="aes-gcm")
    sealed     AES-256-GCM(enc key, nonce, plaintext, aad=device_id)
    mac        HMAC-SHA256(secret, "vexo-mac/v1" + nonce + ct)   integrity + origin
"""

import base64
import hashlib
import hmac
import os
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

KEY_FILE = Path(__file__).resolve().parent / ".device_key"
SECRET_BYTES = 32
NONCE_BYTES = 12
AUTH_LABEL = b"vexo-auth/v1"
MAC_LABEL = b"vexo-mac/v1"
KDF_SALT = b"vexo-records/v1"
KDF_INFO = b"aes-gcm"


def load_or_create_secret(path: Path = KEY_FILE) -> bytes:
    if path.exists():
        return path.read_bytes()
    secret = os.urandom(SECRET_BYTES)
    path.write_bytes(secret)
    path.chmod(0o600)
    return secret


def device_id(secret: bytes) -> str:
    digest = hashlib.sha256(secret).digest()
    return base64.b32encode(digest).decode().lower()[:16]


def auth_token(secret: bytes) -> str:
    return hmac.new(secret, AUTH_LABEL, hashlib.sha256).hexdigest()


def encryption_key(secret: bytes) -> bytes:
    hkdf = HKDF(algorithm=hashes.SHA256(), length=32, salt=KDF_SALT, info=KDF_INFO)
    return hkdf.derive(secret)


def _mac(secret: bytes, nonce: bytes, ct: bytes) -> bytes:
    return hmac.new(secret, MAC_LABEL + nonce + ct, hashlib.sha256).digest()


def seal(secret: bytes, plaintext: bytes) -> dict:
    """Encrypt and authenticate. Only this device can produce or open it."""
    nonce = os.urandom(NONCE_BYTES)
    aad = device_id(secret).encode()
    ct = AESGCM(encryption_key(secret)).encrypt(nonce, plaintext, aad)
    mac = _mac(secret, nonce, ct)
    return {
        "nonce": base64.b64encode(nonce).decode(),
        "ct": base64.b64encode(ct).decode(),
        "mac": mac.hex(),
    }


def open_sealed(secret: bytes, sealed: dict) -> bytes:
    """Verify the device mac, then decrypt. Raises ValueError if tampered."""
    nonce = base64.b64decode(sealed["nonce"])
    ct = base64.b64decode(sealed["ct"])
    expected = _mac(secret, nonce, ct)
    if not hmac.compare_digest(expected.hex(), sealed.get("mac", "")):
        raise ValueError("bad device mac: record was not written by this device")
    aad = device_id(secret).encode()
    return AESGCM(encryption_key(secret)).decrypt(nonce, ct, aad)
