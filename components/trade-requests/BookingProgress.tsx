import clsx from "clsx";
import type {
  TradeBookingProgress,
  TradeBookingRequestDetail,
} from "@/types/round-grouped-trade-booking";

const toneClasses: Record<TradeBookingProgress["tone"], string> = {
  neutral: "border-[#c9c2b4] bg-nearwhite text-charcoal",
  positive: "border-sand bg-cream text-nearblack",
  warning: "border-amber-700/40 bg-amber-50 text-amber-800",
  danger: "border-red-700/40 bg-red-50 text-red-700",
};

export function BookingProgressPill({ progress }: { progress: TradeBookingProgress }) {
  return (
    <span className={clsx("inline-flex border px-2 py-1 text-caption", toneClasses[progress.tone])}>
      {progress.label}
    </span>
  );
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function BookingDeliveryTimeline({ detail }: { detail: TradeBookingRequestDetail }) {
  const emailProblem = detail.email?.bounced_at ?? detail.email?.failed_at ?? detail.email?.suppressed_at;
  const emailTimestamp = detail.email?.sent_at ?? detail.email?.scheduled_for ?? null;
  const responseTimestamp = detail.request.responded_at;
  const partialAnswered = detail.counts.accepted + detail.counts.date_suggested;

  const steps = [
    {
      label: "Request created",
      value: formatDateTime(detail.request.created_at),
      complete: true,
      problem: false,
    },
    {
      label:
        !detail.email
          ? "Email not sent"
          : detail.email.status === "pending"
          ? "Email queued"
          : detail.email.status === "skipped"
            ? "Email not sent"
            : "Email sent",
      value:
        detail.email?.status === "skipped"
          ? detail.email.reason ?? "Needs attention"
          : formatDateTime(emailTimestamp),
      complete: detail.email?.status === "sent",
      problem: !detail.email || detail.email.status === "skipped",
    },
    {
      label: emailProblem ? "Delivery problem" : "Delivered to mail server",
      value: formatDateTime(emailProblem ?? detail.email?.delivered_at ?? null),
      complete: !!detail.email?.delivered_at,
      problem: !!emailProblem,
    },
    {
      label: "Booking page opened",
      value: formatDateTime(detail.request.viewed_at),
      complete: !!detail.request.viewed_at,
      problem: false,
    },
    {
      label: detail.counts.outstanding === 0 ? "Trade responded" : "Trade response",
      value:
        formatDateTime(responseTimestamp) ??
        (partialAnswered > 0 ? `${partialAnswered} of ${detail.counts.total} lines answered` : null),
      complete: detail.counts.outstanding === 0,
      problem: false,
    },
  ];

  return (
    <ol className="grid gap-2 md:grid-cols-5">
      {steps.map((step, index) => (
        <li key={step.label} className="relative border border-[#dcd6cc] bg-offwhite px-3 py-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={clsx(
                "flex h-5 w-5 shrink-0 items-center justify-center border text-[10px]",
                step.problem
                  ? "border-red-700 bg-red-700 text-white"
                  : step.complete
                    ? "border-nearblack bg-nearblack text-white"
                    : "border-[#c9c2b4] text-charcoal/40"
              )}
            >
              {step.problem ? "!" : step.complete ? "✓" : index + 1}
            </span>
            <span className="text-caption text-nearblack">{step.label}</span>
          </div>
          <p className={clsx("mt-2 text-caption", step.problem ? "text-red-700" : "text-charcoal/50")}>
            {step.value ?? "Not yet"}
          </p>
        </li>
      ))}
    </ol>
  );
}
