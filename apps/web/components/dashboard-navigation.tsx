import Link from 'next/link';
import {
  Bot,
  CalendarDays,
  CircleAlert,
  Home,
  ClipboardList,
  CreditCard,
  MessageSquare,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';

import { signOutAction } from '@/app/auth/actions';

const navigation: ReadonlyArray<{ href: string; icon: LucideIcon; label: string }> = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/inbox', label: 'Inbox', icon: MessageSquare },
  { href: '/dashboard/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/dashboard/customers', label: 'Customers', icon: Users },
  { href: '/dashboard/leads', label: 'Leads', icon: ClipboardList },
  { href: '/dashboard/appointments', label: 'Appointments', icon: CalendarDays },
  { href: '/dashboard/needs-attention', label: 'Needs Attention', icon: CircleAlert },
  { href: '/dashboard/ai-front-office', label: 'AI Front Office', icon: Bot },
  { href: '/dashboard/integrations', label: 'Integrations', icon: Settings },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

interface DashboardNavigationProps {
  locationName: string | null;
  organizationName: string;
}

export function DashboardNavigation({ locationName, organizationName }: DashboardNavigationProps) {
  return (
    <aside className="border-b bg-white p-5 md:flex md:min-h-screen md:flex-col md:border-r md:border-b-0">
      <div className="min-w-0">
        <Link
          className="inline-flex items-center gap-2 text-lg font-semibold tracking-tight"
          href="/dashboard"
        >
          <span aria-hidden="true" className="size-2.5 rounded-full bg-primary shadow-signal" />
          Avenlyo
        </Link>
        <p className="mt-5 truncate text-sm font-semibold text-ink">{organizationName}</p>
        <p className="truncate text-xs text-muted-foreground">{locationName ?? 'Workspace'}</p>
      </div>
      <nav aria-label="Dashboard" className="mt-8 space-y-1">
        {navigation.map(({ href, icon: Icon, label }) => (
          <Link
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            href={href}
            key={label}
          >
            <Icon aria-hidden="true" className="size-4" />
            {label}
          </Link>
        ))}
      </nav>
      <form action={signOutAction} className="mt-auto pt-8">
        <button
          className="w-full rounded-md px-3 py-2 text-left text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          type="submit"
        >
          Sign out
        </button>
      </form>
    </aside>
  );
}
