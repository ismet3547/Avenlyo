import Link from 'next/link';
import { Bot, CalendarDays, CircleAlert, Home, MessageSquare, Settings, Users } from 'lucide-react';

const navigation = [
  { href: '/dashboard', label: 'Home', icon: Home },
  { href: '/dashboard/conversations', label: 'Conversations', icon: MessageSquare },
  { href: '/dashboard/customers', label: 'Customers', icon: Users },
  { href: '/dashboard/appointments', label: 'Appointments', icon: CalendarDays },
  { href: '/dashboard/needs-attention', label: 'Needs Attention', icon: CircleAlert },
  { href: '/dashboard/ai-front-office', label: 'AI Front Office', icon: Bot },
  { href: '/dashboard/integrations', label: 'Integrations', icon: Settings },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
] as const;

export function DashboardNavigation() {
  return (
    <aside className="border-b bg-white p-5 md:min-h-screen md:border-r md:border-b-0">
      <Link className="text-lg font-semibold tracking-tight" href="/dashboard">
        Avenlyo
      </Link>
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
    </aside>
  );
}
