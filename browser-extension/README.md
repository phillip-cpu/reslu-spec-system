# RESLU Product Importer

This WebExtension reads normalized product information from a Bunnings product
page that the user has already opened, then opens an authenticated RESLU review
screen. It does **not** send supplier cookies, login data, or page HTML to RESLU,
and the RESLU server does not fetch the supplier page.

## Supported flow

1. Visit a RESLU project once so the extension can remember its project ID
   locally in the browser.
2. Open a product on `www.bunnings.com.au` or `trade.bunnings.com.au`.
3. Select the RESLU Product Importer toolbar button, then **Review in RESLU**.
4. RESLU opens `/product-import` using the existing signed-in Spec session.
5. Choose the FF&E item and tick the values to apply. Blank fields are selected
   automatically; existing values are preserved until explicitly selected.

The source payload is carried in the URL fragment (`#...`), which browsers do
not include in HTTP requests or server logs. The server validates the normalized
payload again and uses the item's `updated_at` value to prevent a stale review
from overwriting a concurrently edited item. Imported image URLs are added as
choices only; this workflow does not hotlink or download an image automatically.

## Chrome installation (development)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this `browser-extension` directory.
4. Approve access only for Bunnings and `spec.reslu.com.au` when Chrome asks.

For managed distribution, package and publish the same directory through the
Chrome Web Store after completing its privacy and permission disclosures.

## Safari installation / conversion

Safari uses Apple's Safari Web Extension container and signing process, while
the extension code remains shared:

```sh
xcrun safari-web-extension-converter /absolute/path/to/browser-extension \
  --project-location /absolute/path/to/generated-safari-project \
  --app-name "RESLU Product Importer" \
  --bundle-identifier au.com.reslu.product-importer
```

Open the generated Xcode project, select the RESLU development team/signing
identity, build the containing macOS app, then enable the extension in Safari
Settings → Extensions. App Store distribution requires an Apple Developer
account and Apple's normal signing/review process. No Safari-specific scraper or
server is required.

## Permissions and privacy

- Site access is limited to Bunnings retail, Bunnings Trade, and RESLU Spec.
- Extraction happens only after the user presses the extension action.
- The passive RESLU content script stores only the last visited project ID/name
  in extension-local storage to preselect project context.
- No proxy, access-control bypass, automated login, cookie replay, background
  scraping, or browser-fingerprint behaviour is present.
- Unsupported pages produce a local explanation and send nothing to RESLU.

## Verification

Run the extension extractor and server payload tests with:

```sh
node --test browser-extension/extractors.test.cjs
node --experimental-strip-types --test lib/browser-product-import.test.ts
```

Then run the normal application checks:

```sh
npm run lint
npm run build
```
