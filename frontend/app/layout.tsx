import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/lib/auth';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cartenz',
  description: 'AI-assisted Odoo development platform by LinkedERP.',
  applicationName: 'Cartenz',
  manifest: '/brand/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/brand/icon-32.png', sizes: '32x32', type: 'image/png' },
      { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    shortcut: '/brand/favicon.ico',
    apple: [{ url: '/brand/icon-180.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#c8102e',
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
