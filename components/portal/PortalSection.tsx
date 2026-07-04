import type { ReactNode } from "react";

/** Shared section chrome — id anchor target, sand label, cream-cream rule. */
export function PortalSection({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-16 border-t border-[#dcd6cc] pt-8">
      <h2 className="label-caps mb-4 !text-sand">{title}</h2>
      {children}
    </section>
  );
}
