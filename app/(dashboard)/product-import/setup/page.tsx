import { Header } from "@/components/layout/Header";

const card = "border border-[#dcd6cc] bg-offwhite p-6";
const step = "flex gap-3 text-sm leading-6 text-charcoal/75";

export default function ProductImporterSetupPage() {
  return (
    <>
      <Header
        title="Browser importer setup"
        subtitle="Import Bunnings product details from the page open in your own browser"
      />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <div className="mx-auto max-w-5xl space-y-6">
          <section className={card}>
            <p className="label-caps mb-3">Why this is needed</p>
            <h2 className="font-display text-2xl text-nearblack">
              Bunnings blocks automatic server access.
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-charcoal/70">
              The RESLU importer reads only the product information already visible on the Bunnings page you opened. It does not send supplier cookies, login details or page HTML to Spec, and it does not bypass Bunnings access controls.
            </p>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className={card}>
              <p className="label-caps mb-3">Google Chrome · available now</p>
              <h2 className="font-display text-2xl text-nearblack">Install the Chrome package</h2>
              <a
                href="/downloads/reslu-product-importer-chrome.zip"
                download
                className="mt-4 inline-block border border-nearblack bg-nearblack px-5 py-3 text-sm text-white"
              >
                Download Chrome importer
              </a>
              <ol className="mt-5 space-y-3">
                {[
                  "Unzip the downloaded file.",
                  "Open chrome://extensions and switch on Developer mode.",
                  "Choose Load unpacked and select the unzipped folder.",
                  "Pin RESLU Product Importer to the Chrome toolbar.",
                ].map((text, index) => (
                  <li key={text} className={step}>
                    <span className="font-medium text-nearblack">{index + 1}.</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            </section>

            <section className={card}>
              <p className="label-caps mb-3">Safari · signing required</p>
              <h2 className="font-display text-2xl text-nearblack">Complete one-time Xcode signing</h2>
              <p className="mt-3 text-sm leading-6 text-charcoal/70">
                The Safari Xcode project is prepared, but Apple requires it to be signed by a valid development team before Safari can install it. This Mac currently has no valid code-signing identity, so an unsigned app has deliberately not been distributed.
              </p>
              <a
                href="/downloads/reslu-product-importer-safari-xcode.zip"
                download
                className="mt-4 inline-block border border-[#c9c2b4] px-5 py-3 text-sm text-nearblack"
              >
                Download Safari Xcode project
              </a>
              <ol className="mt-5 space-y-3">
                {[
                  "In Xcode, open Settings → Accounts and sign in with the RESLU Apple development account.",
                  "Open the downloaded project and choose the RESLU team under Signing & Capabilities for both targets.",
                  "Build and run the containing app, then enable RESLU Product Importer in Safari Settings → Extensions.",
                  "For installation on Tenille’s Mac without Xcode, create a signed and notarized distribution build first.",
                ].map((text, index) => (
                  <li key={text} className={step}>
                    <span className="font-medium text-nearblack">{index + 1}.</span>
                    <span>{text}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          <section className={card}>
            <p className="label-caps mb-3">Per product</p>
            <div className="grid gap-5 sm:grid-cols-4">
              {[
                ["1", "Open the RESLU project once so the extension remembers it."],
                ["2", "Open the Bunnings retail or Trade product page."],
                ["3", "Select RESLU Product Importer in the browser toolbar."],
                ["4", "Review the fields in Spec and confirm the FF&E item."],
              ].map(([number, text]) => (
                <div key={number}>
                  <p className="font-display text-3xl text-sand">{number}</p>
                  <p className="mt-2 text-sm leading-6 text-charcoal/70">{text}</p>
                </div>
              ))}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
