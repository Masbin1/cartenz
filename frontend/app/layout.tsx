import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'LinkedERP AI Development Agent',
  description: 'AI-assisted Odoo development platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-ZA">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
