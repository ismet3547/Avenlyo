import { notFound } from 'next/navigation';

const sections = {
  'ai-front-office': 'AI Front Office',
  appointments: 'Appointments',
  conversations: 'Conversations',
  customers: 'Customers',
  integrations: 'Integrations',
  'needs-attention': 'Needs Attention',
} as const;

interface DashboardSectionPageProps {
  params: Promise<{ section: string }>;
}

export default async function DashboardSectionPage({ params }: DashboardSectionPageProps) {
  const { section } = await params;
  const title = sections[section as keyof typeof sections];

  if (!title) {
    notFound();
  }

  return (
    <section>
      <p className="text-sm font-medium text-primary">Dashboard</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted-foreground">
        This area is intentionally a Phase 0 placeholder.
      </p>
    </section>
  );
}
