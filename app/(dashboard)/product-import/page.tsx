import { Header } from "@/components/layout/Header";
import { BrowserProductImportReview } from "@/components/product-import/BrowserProductImportReview";

export default function ProductImportPage() {
  return (
    <>
      <Header
        title="Import product"
        subtitle="Review browser-captured supplier details before updating an FF&E item"
      />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <BrowserProductImportReview />
      </main>
    </>
  );
}
