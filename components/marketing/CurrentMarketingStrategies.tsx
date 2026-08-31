"use client";

import { useEffect, useState } from "react";
import {
  compactRemainingDuration,
  CURRENT_MARKETING_STRATEGIES,
  marketingStrategySnapshot,
  type MarketingStrategyPhase,
} from "@/lib/marketing-strategies";

interface CurrentMarketingStrategiesProps {
  initialNow: string;
}

const adelaideDateTime = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Adelaide",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const phaseAppearance: Record<
  MarketingStrategyPhase,
  { label: string; className: string }
> = {
  scheduled: {
    label: "Scheduled",
    className: "border-[#dcd6cc] bg-offwhite text-charcoal/70",
  },
  preparing: {
    label: "Hold changes",
    className: "border-[#A08C72] bg-[#f1ebe1] text-[#6f5a3f]",
  },
  observing: {
    label: "Hold changes",
    className: "border-nearblack bg-nearblack text-white",
  },
  review_due: {
    label: "Review due",
    className: "border-[#a13f35] bg-[#f8ecea] text-[#8b332c]",
  },
};

function formatAdelaideDateTime(value: string): string {
  return adelaideDateTime.format(new Date(value));
}

export function CurrentMarketingStrategies({
  initialNow,
}: CurrentMarketingStrategiesProps) {
  const [now, setNow] = useState(() => new Date(initialNow));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section
      aria-labelledby="current-marketing-strategies"
      className="border border-[#cfc7bb] bg-white"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#dcd6cc] bg-offwhite px-5 py-4 sm:px-6">
        <div>
          <p className="label-caps mb-1">Marketing control room</p>
          <h2
            id="current-marketing-strategies"
            className="text-lg font-light tracking-tight text-nearblack"
          >
            Current strategies
          </h2>
          <p className="mt-1 text-body text-charcoal/60">
            What is live, how long to wait, and when the next change can be considered.
          </p>
        </div>
        <p className="border border-[#dcd6cc] bg-white px-3 py-2 text-caption text-charcoal/65">
          {CURRENT_MARKETING_STRATEGIES.length} active window
        </p>
      </div>

      <div className="divide-y divide-[#dcd6cc]">
        {CURRENT_MARKETING_STRATEGIES.map((strategy) => {
          const snapshot = marketingStrategySnapshot(strategy, now);
          const appearance = phaseAppearance[snapshot.phase];
          const nextCheckpoint = snapshot.nextCheckpoint;

          return (
            <article key={strategy.id} className="p-5 sm:p-6">
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_250px]">
                <div className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <span className="label-caps border border-[#dcd6cc] bg-offwhite px-2 py-1 text-charcoal/60">
                      {strategy.channel}
                    </span>
                    <span className="text-caption text-charcoal/45">
                      Owner: {strategy.owner}
                    </span>
                    <span
                      className={`ml-auto border px-3 py-1.5 text-caption font-medium ${appearance.className}`}
                    >
                      {appearance.label}
                    </span>
                  </div>

                  <h3 className="text-section font-display text-nearblack">
                    {strategy.title}
                  </h3>
                  <p className="mt-2 max-w-3xl text-body text-charcoal/70">
                    {strategy.summary}
                  </p>

                  <div className="mt-6">
                    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
                      <div>
                        <p className="label-caps mb-1">Recovery window</p>
                        <p className="text-subhead text-nearblack">
                          <span className="font-medium">{snapshot.completeDays}</span> of{" "}
                          {snapshot.reportingDays} complete reporting days
                        </p>
                      </div>
                      <p className="text-caption text-charcoal/55">
                        {snapshot.progressPercent}% complete
                      </p>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${strategy.title}: ${snapshot.completeDays} of ${snapshot.reportingDays} reporting days complete`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={snapshot.progressPercent}
                      className="h-3 border border-[#cfc7bb] bg-[#ebe5da]"
                    >
                      <div
                        className="h-full bg-[#55705b] transition-[width] duration-500"
                        style={{ width: `${snapshot.progressPercent}%` }}
                      />
                    </div>
                    <div className="mt-2 flex flex-wrap justify-between gap-2 text-caption text-charcoal/50">
                      <span>
                        Started{" "}
                        <time dateTime={strategy.observationStartsAt}>
                          {formatAdelaideDateTime(strategy.observationStartsAt)}
                        </time>
                      </span>
                      <span>
                        {snapshot.reviewDue
                          ? "Decision gate is open"
                          : `${snapshot.reportingDaysRemaining} reporting day${snapshot.reportingDaysRemaining === 1 ? "" : "s"} still to complete`}
                      </span>
                    </div>
                  </div>
                </div>

                <aside
                  aria-label="Next strategy decision"
                  className={`border p-5 ${
                    snapshot.reviewDue
                      ? "border-[#a13f35] bg-[#f8ecea]"
                      : "border-nearblack bg-nearblack text-white"
                  }`}
                >
                  <p
                    className={`label-caps mb-4 ${
                      snapshot.reviewDue ? "text-[#8b332c]" : "text-white/55"
                    }`}
                  >
                    Next change decision
                  </p>
                  <p
                    className={`text-3xl font-light tracking-tight ${
                      snapshot.reviewDue ? "text-[#8b332c]" : "text-white"
                    }`}
                  >
                    {compactRemainingDuration(snapshot.remainingMs)}
                  </p>
                  <p
                    className={`mt-1 text-caption ${
                      snapshot.reviewDue ? "text-[#8b332c]/70" : "text-white/55"
                    }`}
                  >
                    {snapshot.reviewDue ? "Review results before changing anything" : "remaining"}
                  </p>
                  <div
                    className={`mt-5 border-t pt-4 ${
                      snapshot.reviewDue ? "border-[#a13f35]/30" : "border-white/20"
                    }`}
                  >
                    <p
                      className={`label-caps mb-1 ${
                        snapshot.reviewDue ? "text-[#8b332c]" : "text-white/55"
                      }`}
                    >
                      Day 7 gate · Adelaide
                    </p>
                    <time
                      dateTime={strategy.reviewAt}
                      className={`text-body ${
                        snapshot.reviewDue ? "text-[#8b332c]" : "text-white/85"
                      }`}
                    >
                      {formatAdelaideDateTime(strategy.reviewAt)}
                    </time>
                  </div>
                </aside>
              </div>

              <div
                className={`mt-6 border px-4 py-3 ${
                  snapshot.reviewDue
                    ? "border-[#a13f35]/40 bg-[#f8ecea]"
                    : "border-[#d4c5ad] bg-[#f6f0e7]"
                }`}
              >
                <p className="label-caps mb-1">Decision rule</p>
                <p className="text-body text-charcoal/75">
                  {snapshot.reviewDue
                    ? "The seven-day gate is open. Review the commercial and traffic results before approving another change."
                    : strategy.holdInstruction}
                </p>
              </div>

              <div className="mt-6">
                <p className="label-caps mb-2">Scheduled checkpoints · Adelaide</p>
                <div className="grid gap-px border border-[#dcd6cc] bg-[#dcd6cc] sm:grid-cols-3">
                  {strategy.checkpoints.map((checkpoint) => {
                    const complete = new Date(checkpoint.at).getTime() <= now.getTime();
                    const isNext = checkpoint.id === nextCheckpoint?.id;

                    return (
                      <div key={checkpoint.id} className="bg-white p-3">
                        <div className="flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className={`h-2 w-2 shrink-0 ${
                              complete
                                ? "bg-[#55705b]"
                                : isNext
                                  ? "bg-[#A08C72]"
                                  : "border border-[#b8b0a4] bg-white"
                            }`}
                          />
                          <p className="text-body text-nearblack">{checkpoint.label}</p>
                        </div>
                        <div className="mt-1 flex items-center justify-between gap-2 pl-4 text-caption text-charcoal/50">
                          <time dateTime={checkpoint.at}>
                            {formatAdelaideDateTime(checkpoint.at)}
                          </time>
                          <span>{complete ? "Checked" : isNext ? "Next" : "Upcoming"}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mt-6">
                <p className="label-caps mb-2">Live setup</p>
                <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
                  {strategy.liveSetup.map((item) => (
                    <li
                      key={item}
                      className="border-l-2 border-[#A08C72] bg-offwhite px-3 py-2 text-caption text-charcoal/70"
                    >
                      {item}
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-caption text-charcoal/45">
                  Changes activated{" "}
                  <time dateTime={strategy.activatedAt}>
                    {formatAdelaideDateTime(strategy.activatedAt)}
                  </time>{" "}
                  Adelaide time.
                </p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
