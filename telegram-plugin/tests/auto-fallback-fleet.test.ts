/**
 * Tests for the fleet-wide auto-fallback planner. Pure-data —
 * no broker UDS, no Telegram bot. The injected `setActive` is a
 * vi.fn we assert on.
 */
import { describe, it, expect, vi } from 'vitest';
import { runFleetAutoFallback, pickFallbackTarget } from '../auto-fallback-fleet.js';
import type { QuotaResult, QuotaUtilization } from '../quota-check.js';
import type { ListStateData } from '../../src/auth/broker/client.js';

const NOW = new Date('2026-05-15T00:53:00Z');

function quota(part: Partial<QuotaUtilization>): QuotaUtilization {
  return {
    fiveHourUtilizationPct: 0,
    sevenDayUtilizationPct: 0,
    fiveHourResetAt: null,
    sevenDayResetAt: null,
    representativeClaim: null,
    overageStatus: null,
    overageDisabledReason: null,
    ...part,
  };
}

function qOk(part: Partial<QuotaUtilization>): QuotaResult {
  return { ok: true, data: quota(part) };
}

function state(active: string, accounts: string[]): ListStateData {
  return {
    active,
    fallback_order: accounts,
    accounts: accounts.map((label) => ({ label, exhausted: false })),
    agents: [],
    consumers: [],
  };
}

describe('runFleetAutoFallback', () => {
  it('switches to the lowest-utilization healthy account via broker.setActive', async () => {
    const setActive = vi.fn(async (label: string) => ({
      active: label,
      fanned: ['alice', 'bob'],
    }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'me@x', 'pixsoul@x']),
      quotas: [
        // ken: just blew 5h
        qOk({
          fiveHourUtilizationPct: 100,
          fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
          representativeClaim: 'five_hour',
        }),
        // me: dead on 7d for 2 days
        qOk({
          sevenDayUtilizationPct: 100,
          sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
          representativeClaim: 'seven_day',
        }),
        // pixsoul: healthy 5h/7d
        qOk({ fiveHourUtilizationPct: 8, sevenDayUtilizationPct: 20 }),
      ],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive).toHaveBeenCalledWith('pixsoul@x');
    if (out.kind === 'switched') {
      expect(out.oldLabel).toBe('ken@x');
      expect(out.newLabel).toBe('pixsoul@x');
      expect(out.announcement).toContain('5-hour limit on ken@x');
      expect(out.announcement).toContain('Triggered by: agent <b>carrie</b>');
      expect(out.announcement).toContain('plenty of headroom');
    }
  });

  it('returns all-blocked WITHOUT calling setActive when every alternative is blocked', async () => {
    const setActive = vi.fn();
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'me@x']),
      quotas: [
        qOk({
          fiveHourUtilizationPct: 100,
          fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
          representativeClaim: 'five_hour',
        }),
        qOk({
          sevenDayUtilizationPct: 100,
          sevenDayResetAt: new Date('2026-05-17T10:00:00Z'),
          representativeClaim: 'seven_day',
        }),
      ],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('all-blocked');
    expect(setActive).not.toHaveBeenCalled();
    if (out.kind === 'all-blocked') {
      expect(out.announcement).toContain('All accounts blocked');
      expect(out.announcement).toContain('/auth add');
    }
  });

  it('idempotency: skips swap when active probes healthy (stale event)', async () => {
    const setActive = vi.fn();
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'pixsoul@x']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 10 }),
        qOk({ fiveHourUtilizationPct: 5, sevenDayUtilizationPct: 10 }),
      ],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('no-eligible-target');
    expect(setActive).not.toHaveBeenCalled();
    expect(out.announcement).toContain('skipped');
    expect(out.announcement).toContain('Stale event?');
  });

  it('returns no-old-active when broker has no active account (corrupt state)', async () => {
    const setActive = vi.fn();
    const out = await runFleetAutoFallback({
      state: { active: '', fallback_order: [], accounts: [], agents: [], consumers: [] },
      quotas: [],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('no-old-active');
    expect(setActive).not.toHaveBeenCalled();
  });

  it('falls back to a throttling alternative when no healthy one exists', async () => {
    const setActive = vi.fn(async (label: string) => ({ active: label, fanned: [] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'pixsoul@x']),
      quotas: [
        qOk({
          fiveHourUtilizationPct: 100,
          fiveHourResetAt: new Date('2026-05-15T05:50:00Z'),
          representativeClaim: 'five_hour',
        }),
        // pixsoul throttling at 85% but not blocked
        qOk({ fiveHourUtilizationPct: 85, sevenDayUtilizationPct: 20 }),
      ],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(setActive).toHaveBeenCalledWith('pixsoul@x');
    if (out.kind === 'switched') {
      expect(out.announcement).toContain('near limit — watch this');
    }
  });

  it('skips unknown-health (probe failed) when picking a target', async () => {
    const setActive = vi.fn(async (label: string) => ({ active: label, fanned: [] }));
    const out = await runFleetAutoFallback({
      state: state('ken@x', ['ken@x', 'broken@x', 'pixsoul@x']),
      quotas: [
        qOk({ fiveHourUtilizationPct: 100, fiveHourResetAt: new Date('2026-05-15T05:50:00Z') }),
        { ok: false, reason: 'HTTP 401' },
        qOk({ fiveHourUtilizationPct: 5 }),
      ],
      setActive,
      triggerAgent: 'carrie',
      now: NOW,
      tz: 'UTC',
    });

    expect(out.kind).toBe('switched');
    expect(setActive).toHaveBeenCalledWith('pixsoul@x');
  });
});

describe('pickFallbackTarget', () => {
  it('prefers lower-5h-utilization healthy account', () => {
    const snaps = [
      { label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) },
      { label: 'low@x', isActive: false, quota: quota({ fiveHourUtilizationPct: 5 }) },
      { label: 'med@x', isActive: false, quota: quota({ fiveHourUtilizationPct: 30 }) },
    ];
    const target = pickFallbackTarget(snaps);
    expect(target?.label).toBe('low@x');
  });

  it('returns null when only blocked alternatives exist', () => {
    const snaps = [
      { label: 'a@x', isActive: true, quota: quota({ fiveHourUtilizationPct: 100 }) },
      { label: 'b@x', isActive: false, quota: quota({ sevenDayUtilizationPct: 100 }) },
    ];
    expect(pickFallbackTarget(snaps)).toBeNull();
  });
});
