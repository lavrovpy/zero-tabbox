# Publishing

Local installs (Chrome unpacked, Firefox temporary add-on) are covered in the
[README](README.md#install). This file covers getting a build in front of
users outside a local checkout.

## Firefox (signed, permanent)

Firefox will not permanently install an unsigned extension. Mozilla signs
self-distributed builds without a public listing, through the "unlisted"
channel:

1. Generate a JWT issuer and secret at
   <https://addons.mozilla.org/developers/addon/api/key/>.
2. Sign the build:

   ```bash
   bunx web-ext sign \
     --channel unlisted \
     --api-key "$AMO_JWT_ISSUER" \
     --api-secret "$AMO_JWT_SECRET" \
     --source-dir dist/firefox \
     --artifacts-dir artifacts
   ```

   A first-ever submission additionally needs `--amo-metadata <file.json>`.
3. Install the resulting `.xpi` from `about:addons` → gear icon → **Install
   Add-on From File…**.

The add-on id (`zero-tabbox@lavrov.dev`) is fixed in the manifest, which AMO
requires for Manifest V3 submissions and which keeps updates on the same id.

To let it sweep private windows, open `about:addons` → the extension → **Run in
Private Windows: Allow**.

## Store listings

Chrome Web Store and AMO public listings are an optional follow-up — neither
exists yet. [`store-compliance.md`](store-compliance.md) audits both builds
against the Chrome Web Store program policies and the Mozilla add-on policies —
the code and both manifests pass, and what is left is submission paperwork: the
Chrome privacy-practices answers (which must give the same answer the Firefox
manifest already gives: no data collected — see [README § Data
collection](README.md#data-collection)), the AMO source-code build
instructions, and listing assets. All of it is drafted there ready to paste.
[`PRIVACY.md`](PRIVACY.md) is the privacy policy a listing can link to. The
listing screenshots live in `store/`, regenerated from the real extension by
two scripts — see [`store/README.md`](store/README.md).
