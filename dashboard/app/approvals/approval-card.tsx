'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ApprovalRow } from '../../lib/api';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export function ApprovalCard({ row, idx }: { row: ApprovalRow; idx: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  async function approve() {
    setBusy('approve');
    try {
      await fetch(`${API}/api/approvals/${row.item.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedBy: 'dashboard-user' }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (reason.length < 2) return;
    setBusy('reject');
    try {
      await fetch(`${API}/api/approvals/${row.item.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, rejectedBy: 'dashboard-user' }),
      });
      setShowReject(false);
      setReason('');
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t-2 border-paper-ink first:border-t-2 last:border-b-2 py-6">
      <div className="flex items-baseline justify-between gap-6 mb-4">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-paper-muted text-sm tabular-nums">{(idx + 1).toString().padStart(2, '0')}.</span>
          <h3 className="text-xl font-bold lowercase">{row.item.topic.toLowerCase()}</h3>
        </div>
        <div className="text-2xs text-paper-muted tabular-nums whitespace-nowrap">
          {new Date(row.item.createdAt).toLocaleString()}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-2xs text-paper-muted mb-5">
        <span>type={row.item.type}</span>
        <span>industry={row.industryName?.toLowerCase() ?? '—'}</span>
        <span>lang={row.item.language}</span>
        {row.personaName && <span>persona={row.personaName.toLowerCase()}</span>}
        <span>campaign={row.campaignName?.toLowerCase()}</span>
      </div>

      <dl className="space-y-4 mb-6 text-sm">
        <div className="grid grid-cols-[8rem_1fr] gap-4">
          <dt className="text-2xs uppercase tracking-wider text-paper-muted pt-0.5">hook</dt>
          <dd className="font-bold">{row.item.hook}</dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-4">
          <dt className="text-2xs uppercase tracking-wider text-paper-muted pt-0.5">script</dt>
          <dd>
            <pre className="whitespace-pre-wrap leading-relaxed bg-paper-tint border border-paper-edge p-4">{row.item.script}</pre>
          </dd>
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-4">
          <dt className="text-2xs uppercase tracking-wider text-paper-muted pt-0.5">cta</dt>
          <dd>{row.item.cta}</dd>
        </div>
      </dl>

      {showReject ? (
        <div className="space-y-3">
          <label className="block">
            <span className="text-2xs uppercase tracking-wider text-paper-muted mb-1.5 block">// rejection reason</span>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="why reject? (sent back to script-writer for regeneration)"
              rows={3}
              className="w-full font-mono text-sm bg-paper-tint border border-paper-ink p-3 placeholder:text-paper-muted focus:outline-none focus:border-signal-alert"
            />
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => void reject()}
              disabled={reason.length < 2 || busy !== null}
              className="border border-signal-alert text-signal-alert px-4 py-1.5 text-sm hover:bg-signal-alert hover:text-paper transition disabled:opacity-50"
            >
              [{busy === 'reject' ? ' rejecting… ' : ' confirm reject '}]
            </button>
            <button
              onClick={() => { setShowReject(false); setReason(''); }}
              className="text-sm text-paper-muted hover:text-paper-ink px-2"
            >
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={() => void approve()}
            disabled={busy !== null}
            className="border border-accent text-accent px-4 py-1.5 text-sm hover:bg-accent hover:text-paper transition disabled:opacity-50 font-bold"
          >
            [{busy === 'approve' ? ' approving… ' : ' approve '}]
          </button>
          <button
            onClick={() => setShowReject(true)}
            disabled={busy !== null}
            className="border border-paper-ink text-paper-ink px-4 py-1.5 text-sm hover:bg-paper-ink hover:text-paper transition disabled:opacity-50"
          >
            [ reject ]
          </button>
        </div>
      )}
    </div>
  );
}
