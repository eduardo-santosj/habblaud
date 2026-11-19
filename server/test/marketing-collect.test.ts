import { describe, expect, it } from 'vitest';
import { juntarOnline } from '../../scripts/marketing-collect';

describe('online_followers', () => {
  it('converte a hora da Meta (UTC-8) para São Paulo e junta os dias, sem repetir e até o limite', () => {
    const valor = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), h]));
    const r = { data: [{ values: [{ value: valor, end_time: '2026-11-17T08:00:00+0000' }, { value: {}, end_time: '2026-11-18T08:00:00+0000' }] }] };
    const dias = juntarOnline(r);
    expect(Object.keys(dias)).toEqual(['2026-11-17T08:00:00+0000']);
    // 0h no Pacífico = 5h em São Paulo.
    expect(dias['2026-11-17T08:00:00+0000']![5]).toBe(0);
    expect(dias['2026-11-17T08:00:00+0000']![4]).toBe(23);
    const mais = juntarOnline({ data: [{ values: [{ value: valor, end_time: '2026-11-19T08:00:00+0000' }] }] }, dias, 1);
    expect(Object.keys(mais)).toEqual(['2026-11-19T08:00:00+0000']);
  });
});
