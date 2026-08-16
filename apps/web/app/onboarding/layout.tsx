import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Set up your workspace | Avenlyo',
};

export default function OnboardingLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
