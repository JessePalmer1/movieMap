import Link from "next/link";

export default function Home() {
  return (
    <div className="mx-auto flex min-h-[80vh] max-w-2xl flex-col justify-center px-6 py-16">
      <h1 className="text-5xl font-bold tracking-tight sm:text-6xl">movieMap</h1>

      <p className="mt-6 text-lg leading-relaxed text-muted">
        What you want to watch depends on the mood you are in right now, not the taste you
        have in general. Nobody can describe that mood accurately — but everyone can answer{" "}
        <em className="text-foreground not-italic">which of these two, tonight?</em>
      </p>

      <ol className="mt-10 space-y-4 text-sm text-muted">
        <li className="flex gap-4">
          <span className="font-mono text-accent">01</span>
          <span>Tell us a few films you have already seen.</span>
        </li>
        <li className="flex gap-4">
          <span className="font-mono text-accent">02</span>
          <span>
            Pick between them, ten times. Not which is better — which you would rather
            watch right now.
          </span>
        </li>
        <li className="flex gap-4">
          <span className="font-mono text-accent">03</span>
          <span>Get three films you have not seen that match the mood behind those picks.</span>
        </li>
      </ol>

      <Link
        href="/onboarding"
        className="mt-12 inline-flex w-fit items-center rounded-full bg-accent px-8 py-3.5 font-semibold text-accent-contrast transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Find something to watch
      </Link>
    </div>
  );
}
