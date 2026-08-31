'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { PageLoading } from '@/components/ui/spinner';

/**
 * The root route resolves the session and sends the user to the right place,
 * rather than rendering a landing page the portal does not need.
 */
export default function RootPage() {
  const { loading, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [loading, user, router]);

  return <PageLoading label="Starting LinkedERP" />;
}
