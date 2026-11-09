import type { Metadata, Viewport } from 'next';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { ToastProvider } from '@relay/ui/client';
import '@relay/ui/relay-tokens.css';
import '@relay/ui/base.css';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Relay', template: '%s · Relay' },
  description: 'Publishing workspace for social media marketers and clippers.',
  icons: { icon: '/icon.svg' },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FDFCF9' },
    { media: '(prefers-color-scheme: dark)', color: '#141414' },
  ],
};

/** Theme preference lives in a cookie so the server renders the right theme with no inline script. */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get('relay_theme')?.value;
  return (
    <html lang="en" data-theme={theme === 'light' || theme === 'dark' ? theme : undefined}>
      <body>
        <a className="r-skip-link" href="#main">
          Skip to content
        </a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
