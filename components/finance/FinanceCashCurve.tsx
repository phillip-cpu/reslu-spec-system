"use client";

import clsx from "clsx";
import { formatFinanceDate, formatMinorCurrency } from "@/lib/finance/presentation";
import type { FinanceProjectionPeriod } from "@/types/finance";

export function FinanceCashCurve({
  periods,
  selectedIndex,
  onSelect,
}: {
  periods: FinanceProjectionPeriod[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  if (periods.length === 0) {
    return <p className="py-16 text-center text-body text-charcoal/55">No periods available.</p>;
  }

  const width = 920;
  const height = 260;
  const padX = 34;
  const padY = 30;
  const values = periods.flatMap((period) => [period.openingCashMinor, period.closingCashMinor]);
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 0);
  const range = Math.max(maxValue - minValue, 1);
  const x = (index: number) =>
    padX + (index / Math.max(periods.length - 1, 1)) * (width - padX * 2);
  const y = (value: number) =>
    padY + ((maxValue - value) / range) * (height - padY * 2);
  const path = periods
    .map((period, index) => `${index === 0 ? "M" : "L"}${x(index)} ${y(period.closingCashMinor)}`)
    .join(" ");
  const zeroY = y(0);

  return (
    <div className="overflow-x-auto" aria-label="13-week closing cash curve">
      <div className="min-w-[720px]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full"
          role="img"
          aria-labelledby="finance-cash-curve-title finance-cash-curve-description"
        >
          <title id="finance-cash-curve-title">Projected closing cash by week</title>
          <desc id="finance-cash-curve-description">
            Select a point to inspect that week. A visible zero line marks negative cash.
          </desc>
          <line
            x1={padX}
            x2={width - padX}
            y1={zeroY}
            y2={zeroY}
            stroke="#B23A3A"
            strokeWidth="1"
            strokeDasharray="5 5"
            opacity="0.45"
          />
          <path d={path} fill="none" stroke="#1A1A1A" strokeWidth="3" />
          {periods.map((period, index) => (
            <g
              key={period.startsOn}
              role="button"
              tabIndex={0}
              aria-label={`Week of ${formatFinanceDate(period.startsOn)}, closing cash ${formatMinorCurrency(period.closingCashMinor)}`}
              onClick={() => onSelect(index)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(index);
                }
              }}
              className="cursor-pointer focus:outline-none"
            >
              <circle
                cx={x(index)}
                cy={y(period.closingCashMinor)}
                r={selectedIndex === index ? 8 : 5}
                fill={period.closingCashMinor < 0 ? "#B23A3A" : selectedIndex === index ? "#A08C72" : "#1A1A1A"}
                stroke="#F5F1E8"
                strokeWidth="3"
              />
              <circle cx={x(index)} cy={y(period.closingCashMinor)} r="16" fill="transparent" />
            </g>
          ))}
        </svg>
        <div className="grid grid-cols-[repeat(13,minmax(0,1fr))] gap-0 border-t border-charcoal/15">
          {periods.map((period, index) => (
            <button
              key={period.startsOn}
              type="button"
              onClick={() => onSelect(index)}
              className={clsx(
                "border-r border-charcoal/10 px-1 py-2 text-center text-[7px] uppercase tracking-[0.08em] last:border-r-0",
                selectedIndex === index ? "bg-nearblack text-white" : "text-charcoal/55 hover:bg-cream"
              )}
            >
              {new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }).format(
                new Date(`${period.startsOn}T00:00:00Z`)
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
