import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { DashboardNavigation } from '@/components/dashboard-navigation';
import { getOptionalCurrentUser } from '@/lib/supabase/auth';
import { isSupabaseConfigured } from '@/lib/supabase/config';

export default async function DashboardLayout({ children }: Readonly<{ children: ReactNode }>) {
  if (isSupabaseConfigured) {
    const user = await getOptionalCurrentUser();

    if (!user) {
      redirect('/auth/sign-in');
    }
  }

  return (
    <div className="min-h-screen bg-muted/40 md:grid md:grid-cols-[15rem_1fr]">
      <DashboardNavigation />
      <main className="min-w-0 px-6 py-8 md:px-10">{children}</main>
    </div>
  );
}
