export function ConfirmationClosedNotice({
  completed = false,
}: {
  completed?: boolean;
}) {
  return (
    <div className="border border-[#dcd6cc] bg-offwhite px-5 py-5">
      <p className="label-caps">No confirmation required</p>
      <h1 className="mt-2 font-display text-section text-nearblack">
        This booking request is closed
      </h1>
      <p className="mt-3 text-body text-charcoal/70">
        {completed
          ? "RESLU has marked this work as completed, so you don’t need to confirm the visit."
          : "RESLU has closed this booking request. You don’t need to respond."}
      </p>
    </div>
  );
}
