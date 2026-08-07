'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const MODES = ['manual', 'hitl', 'auto'] as const;
type Mode = (typeof MODES)[number];

export function AutonomyToggle({ campaignId, current }: { campaignId: string; current: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<Mode | null>(null);

  async function set(mode: Mode) {
    if (mode === current) return;
    setPending(mode);
    try {
      await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autonomyMode: mode }),
      });
      router.refresh();
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="inline-flex border border-paper-ink text-sm">
      {MODES.map((m) => {
        const active = current === m;
        return (
          <button
            key={m}
            onClick={() => void set(m)}
            disabled={pending !== null}
            className={`px-3 py-1.5 transition border-r border-paper-ink last:border-r-0 ${
              active
                ? 'bg-paper-ink text-paper'
                : 'text-paper-muted hover:bg-paper-tint hover:text-paper-ink'
            } ${pending === m ? 'opacity-50' : ''}`}
          >
            [{m}]
          </button>
        );
      })}
    </div>
  );
}
