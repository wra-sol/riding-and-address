import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreakerDO } from '../src/circuit-breaker-do';
import type { CircuitBreakerState } from '../src/types';

function createMockStorage() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async <T>(key: string): Promise<T | undefined> => store.get(key) as T | undefined),
    put: vi.fn(async (key: string, value: unknown) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: Array.from(store.keys()).map((name) => ({ name })) })),
    getAlarm: vi.fn(async () => null),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
    transaction: vi.fn(async (callback: unknown) => {
      if (typeof callback === 'function') {
        return await callback();
      }
    }),
  };
}

function createMockState(storage: ReturnType<typeof createMockStorage>) {
  return {
    storage,
    id: { toString: () => 'mock-do-id', equals: () => false },
    waitUntil: vi.fn(),
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => []),
    getTags: vi.fn(() => []),
    getStub: vi.fn(),
    getHibernatableWebSocketEventTimeout: vi.fn(() => null),
    setWebSocketAutoResponse: vi.fn(),
    getWebSocketAutoResponse: vi.fn(() => null),
    setHibernatableWebSocketEventTimeout: vi.fn(),
    abort: vi.fn(),
    onReady: vi.fn(),
    blockConcurrencyWhile: vi.fn(async (callback: unknown) => {
      if (typeof callback === 'function') {
        return await callback();
      }
    }),
  } as unknown as DurableObjectState;
}

function createMockEnv() {
  return {} as unknown as import('../src/types').Env;
}

describe('CircuitBreakerDO', () => {
  let storage: ReturnType<typeof createMockStorage>;
  let state: DurableObjectState;
  let doInstance: CircuitBreakerDO;

  beforeEach(() => {
    storage = createMockStorage();
    state = createMockState(storage);
    doInstance = new CircuitBreakerDO(state, createMockEnv());
  });

  it('initializes with default thresholds', () => {
    // The constructor calls loadState (async) but doesn't await it;
    // verify the instance was created without throwing
    expect(doInstance).toBeInstanceOf(CircuitBreakerDO);
  });

  describe('handleSuccess / handleFailure', () => {
    it('remains CLOSED after fewer failures than threshold', async () => {
      await doInstance.handleFailure('svc-a');
      await doInstance.handleFailure('svc-a');
      await doInstance.handleFailure('svc-a');
      await doInstance.handleFailure('svc-a');

      const info = await doInstance.getStateInfo('svc-a');
      expect(info?.state).toBe('CLOSED');
      expect(info?.failureCount).toBe(4);
    });

    it('opens circuit after failureThreshold failures', async () => {
      for (let i = 0; i < 5; i++) {
        await doInstance.handleFailure('svc-b');
      }

      const info = await doInstance.getStateInfo('svc-b');
      expect(info?.state).toBe('OPEN');
      expect(info?.failureCount).toBe(5);
    });

    it('resets failure count on success', async () => {
      await doInstance.handleFailure('svc-c');
      await doInstance.handleFailure('svc-c');
      await doInstance.handleSuccess('svc-c');

      const info = await doInstance.getStateInfo('svc-c');
      expect(info?.failureCount).toBe(0);
    });

    it('transitions HALF_OPEN to CLOSED after successThreshold successes', async () => {
      // Open the circuit first
      for (let i = 0; i < 5; i++) {
        await doInstance.handleFailure('svc-d');
      }

      // Manually set lastFailureTime to be in the past so recovery timeout has passed
      const statesMap = (doInstance as unknown as { states: Map<string, CircuitBreakerState> }).states;
      const svcD = statesMap.get('svc-d')!;
      svcD.lastFailureTime = Date.now() - 61000;
      svcD.nextAttemptTime = Date.now() - 1000;

      const check = await doInstance.checkState('svc-d');
      expect(check.allowed).toBe(true);
      expect(check.state.state).toBe('HALF_OPEN');

      await doInstance.handleSuccess('svc-d');
      await doInstance.handleSuccess('svc-d');
      await doInstance.handleSuccess('svc-d');

      const info = await doInstance.getStateInfo('svc-d');
      expect(info?.state).toBe('CLOSED');
    });
  });

  describe('checkState', () => {
    it('allows execution when CLOSED', async () => {
      const result = await doInstance.checkState('new-svc');
      expect(result.allowed).toBe(true);
      expect(result.state.state).toBe('CLOSED');
    });

    it('blocks execution when OPEN and recovery timeout has not passed', async () => {
      for (let i = 0; i < 5; i++) {
        await doInstance.handleFailure('blocked-svc');
      }

      const result = await doInstance.checkState('blocked-svc');
      expect(result.allowed).toBe(false);
      expect(result.state.state).toBe('OPEN');
    });

    it('allows execution when OPEN but recovery timeout has passed', async () => {
      for (let i = 0; i < 5; i++) {
        await doInstance.handleFailure('recover-svc');
      }

      const statesMap = (doInstance as unknown as { states: Map<string, CircuitBreakerState> }).states;
      const svc = statesMap.get('recover-svc')!;
      svc.lastFailureTime = Date.now() - 61000;
      svc.nextAttemptTime = Date.now() - 1000;

      const result = await doInstance.checkState('recover-svc');
      expect(result.allowed).toBe(true);
      expect(result.state.state).toBe('HALF_OPEN');
    });
  });

  describe('reset / resetAll', () => {
    it('reset removes a specific key', async () => {
      await doInstance.handleFailure('reset-me');
      await doInstance.reset('reset-me');

      const info = await doInstance.getStateInfo('reset-me');
      expect(info).toBeNull();
    });

    it('resetAll clears all states', async () => {
      await doInstance.handleFailure('a');
      await doInstance.handleFailure('b');
      await doInstance.resetAll();

      const all = await doInstance.getAllStates();
      expect(all.size).toBe(0);
    });
  });

  describe('getAllStates', () => {
    it('returns all tracked states', async () => {
      await doInstance.handleFailure('x');
      await doInstance.handleSuccess('y');

      const all = await doInstance.getAllStates();
      expect(all.size).toBe(2);
      expect(all.get('x')?.state).toBe('CLOSED');
      expect(all.get('y')?.state).toBe('CLOSED');
    });
  });

  describe('updateConfig', () => {
    it('updates thresholds', async () => {
      await doInstance.updateConfig(1, 1000, 1);

      // With threshold 1, a single failure should open the circuit
      await doInstance.handleFailure('low-threshold');

      const info = await doInstance.getStateInfo('low-threshold');
      expect(info?.state).toBe('OPEN');
    });
  });

  describe('fetch endpoint', () => {
    it('handles /success POST', async () => {
      const req = new Request('https://fake/success', {
        method: 'POST',
        body: JSON.stringify({ key: 'test-svc' }),
      });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it('handles /failure POST', async () => {
      const req = new Request('https://fake/failure', {
        method: 'POST',
        body: JSON.stringify({ key: 'fail-svc' }),
      });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
    });

    it('handles /check POST', async () => {
      const req = new Request('https://fake/check', {
        method: 'POST',
        body: JSON.stringify({ key: 'check-svc' }),
      });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json() as { allowed: boolean; state: CircuitBreakerState };
      expect(body.allowed).toBe(true);
      expect(body.state.state).toBe('CLOSED');
    });

    it('handles /state GET with key', async () => {
      await doInstance.handleFailure('state-svc');
      const req = new Request('https://fake/state?key=state-svc');
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json() as CircuitBreakerState;
      expect(body.state).toBe('CLOSED');
      expect(body.failureCount).toBe(1);
    });

    it('handles /state GET without key', async () => {
      await doInstance.handleFailure('all-a');
      const req = new Request('https://fake/state');
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, CircuitBreakerState>;
      expect(Object.keys(body)).toContain('all-a');
    });

    it('handles /reset POST with key', async () => {
      await doInstance.handleFailure('reset-key');
      const req = new Request('https://fake/reset?key=reset-key', { method: 'POST' });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.success).toBe(true);
      expect(body.message).toContain('reset');
    });

    it('handles /reset POST without key', async () => {
      const req = new Request('https://fake/reset', { method: 'POST' });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      const body = await res.json() as { success: boolean; message: string };
      expect(body.message).toBe('All circuit breakers reset');
    });

    it('handles /config POST', async () => {
      const req = new Request('https://fake/config', {
        method: 'POST',
        body: JSON.stringify({ failureThreshold: 10, recoveryTimeout: 120000, successThreshold: 5 }),
      });
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
    });

    it('returns 404 for unknown paths', async () => {
      const req = new Request('https://fake/unknown');
      const res = await doInstance.fetch(req);
      expect(res.status).toBe(404);
    });
  });
});
