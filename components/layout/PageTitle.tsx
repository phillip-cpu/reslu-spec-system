interface PageTitleProps {
  children: React.ReactNode;
}

/** Consistent page heading used inside dashboard content areas. */
export function PageTitle({ children }: PageTitleProps) {
  return <h2 className="text-subhead font-medium text-nearblack mb-4">{children}</h2>;
}
