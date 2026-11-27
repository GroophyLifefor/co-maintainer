# License key setup

The product trusts the public keys listed in `keys.ts`, and the list is empty until the license signing key's public half is added. The private key stays on the signing machine and is never read by the product.

1. On the machine with the private key: `node ee/license/public_key.ts /path/to/private-key.pem k-1` (the key id is optional). The key must be an unencrypted Ed25519 PEM (what `openssl genpkey -algorithm ed25519` writes, not an OpenSSH key file). It prints the public key and a ready line, and nothing from the private key.
2. Paste the printed line inside `LICENSE_KEYS` in `ee/license/keys.ts`. Keep a second, offline spare key in the same list.
3. Check it: sign a test license with that private key and run it through `verifyLicenseFile`.
