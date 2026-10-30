# Security boundaries (MVP)

This is an experimental implementation, not audited security software.

## Implemented protections

NaCl `box` (TweetNaCl) encrypts and authenticates payloads with a fresh 24-byte random nonce. Both peers pin public keys, and compare a shared-key-derived security code before explicit desktop approval. Routing room/sender/recipient is authenticated inside ciphertext. Low-order peer keys are rejected. QR contains a public key and short-lived single-use capability, **not a private key**; the capability is in a URL fragment. A stolen QR before consumption can still attempt pairing, so compare codes and reject unknown requests.

Relay bearer capabilities are random, hashed for stored authentication, and never passed in WebSocket query strings. Same-origin browser restrictions, bounded connections/messages, per-room rate limits and pending-auth deadlines reduce misuse. These are not global public-service abuse controls. Receiver checks approved pinned keys, current connection session, message UUID, expiry, size and control characters; duplicate IDs are marked before injection. No offline content storage or replay after reconnect.

Desktop secrets use Electron safeStorage; plaintext/keychain-unavailable fallback is refused. Phone keys live in localStorage for this MVP: same-origin compromised JavaScript/browser profile access can steal them. A dedicated trusted origin, HTTPS and no third-party scripts are essential. This is not hardware-backed browser key storage. Static keys provide no forward secrecy. Pairing data is not logged deliberately, but third-party proxy/browser/history/diagnostic infrastructure must also be reviewed.

## Threats and limitations

The relay sees routing IDs, timing, sizes and availability, can drop/delay traffic, and can deny service. It cannot decrypt honest-client content using only stored server metadata. A compromised origin serving the Web UI can change that UI and steal keys/plaintext: this threat is not solved by payload encryption. Keys must be revoked after compromise. A resumed browser trusted identity grants access to its paired computer while receiving is enabled.

Global focus injection has a final-check/event-delivery race. macOS helper refuses secure/unsupported AX fields, but this is defense in depth, not a guarantee against every sensitive application. Payload newline/tab may be interpreted by applications even without synthesized Return keys. Partial injection is possible. Never automatically retry unknown outcomes. Restart/session rotation rejects old messages rather than claiming crash-proof exactly-once semantics.

Terminal support is **WIP**: explicit tmux pane, opt-in, literal single-line send, no Enter, no shell interpolation; control characters/newlines are refused. This does not establish arbitrary terminal safety or foreground detection. Windows injection is not implemented.

## Before production

Perform independent cryptographic/protocol review, OS focus/secure-input acceptance, origin hardening/CSP review, automated accessibility/UI tests, key lifecycle/backup decisions, threat-informed rate controls and cost monitoring. Package/sign/notarize desktop builds. Establish update integrity and incident/revocation process. Confirm actual regional connectivity on intended networks; prior successful access is not an availability guarantee.
