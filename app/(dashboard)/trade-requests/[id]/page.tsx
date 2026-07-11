import { Header } from "@/components/layout/Header";
import { TradeRequestDetail } from "@/components/trade-requests/TradeRequestDetail";

/**
 * /trade-requests/[id] — Grouped trade booking round (r20) admin
 * detail view for one trade_booking_requests row (BUILD-SPEC.md item
 * 5: "Admin actions on the visit/panel: 'Accept new date + shift
 * timeline' ... or 'Keep original + reply'"). Deep-linked from the
 * daily_brief_items "{Trade} suggested new dates — {task}" attention
 * row (POST /api/trade-request/[token]/respond's 'suggest' action) and
 * from the My Work "follow-up" source (GET /api/my-work, source #11).
 *
 * Server shell only (mirrors /cpd, /my-work) — TradeRequestDetail does
 * its own GET /api/trade-requests/[id] fetch client-side, since a
 * request's line states change on every admin action and gain no
 * benefit from a server-side initial read.
 */
export default async function TradeRequestDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <>
      <Header title="Trade request" subtitle="Grouped trade booking — one request, many dates." />
      <main className="flex-1 px-8 py-8">
        <TradeRequestDetail requestId={id} />
      </main>
    </>
  );
}
