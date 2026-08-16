interface PageHeadingProps {
  description: string;
  eyebrow: string;
  title: string;
}

export function PageHeading({ description, eyebrow, title }: PageHeadingProps) {
  return (
    <header>
      <p className="font-utility text-xs font-semibold uppercase tracking-[0.18em] text-primary">
        {eyebrow}
      </p>
      <h1 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">
        {title}
      </h1>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base sm:leading-7">
        {description}
      </p>
    </header>
  );
}
