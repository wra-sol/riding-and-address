import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueueManagerDO, QueueJob, BatchJob } from '../src/queue-manager';
import { Env } from '../src/types';

function createMockState(initialStorage?: Map<string, unknown>) {
  const storage = initialStorage ?? new Map<string, unknown>();
  return {
    storage: {
      get: vi.fn((key: string) => Promise.resolve(storage.get(key) ?? null)),
      put: vi.fn((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        storage.delete(key);
        return Promise.resolve();
      }),
      list: vi.fn(() => Promise.resolve(new Map())),
    },
    waitForOpenConnections: vi.fn(() => Promise.resolve()),
    getWebSockets: vi.fn(() => []),
    acceptWebSocket: vi.fn(),
    getWebSocketAutoResponse: vi.fn(),
    setWebSocketAutoResponse: vi.fn(),
    getTags: vi.fn(() => []),
    getAlarm: vi.fn(() => Promise.resolve(null)),
    setAlarm: vi.fn(() => Promise.resolve()),
    deleteAlarm: vi.fn(() => Promise.resolve()),
    getHibernatableWebSocketState: vi.fn(),
    setHibernatableWebSocketState: vi.fn(),
    getHibernatableWebSocketAutoResponse: vi.fn(),
    setHibernatableWebSocketAutoResponse: vi.fn(),
    sql: undefined as unknown as SqlStorage,
    id: { toString: () => 'mock-do-id', equals: () => true } as DurableObjectId,
  } as unknown as DurableObjectState;
}

function createEnv(): Env {
  return {} as Env;
}

function makeRequest(path: string, method = 'GET', body?: unknown): Request {
  const url = `https://mock-do.example${path}`;
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function createQueueManager(state?: DurableObjectState, env?: Env) {
  const doState = state ?? createMockState();
  const manager = new QueueManagerDO(doState, env ?? createEnv());
  // Speed up simulated job processing
  (manager as unknown as Record<string, unknown>).processJob = async (job: QueueJob) => ({
    id: job.request.id,
    query: job.request.query,
    point: { lon: -75.7, lat: 45.4 },
    properties: { FED_NAME: 'Ottawa Centre' },
    processingTime: 50,
  });
  return manager;
}

describe('QueueManagerDO', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('state loading', () => {
    it('loads persisted state on initialization', async () => {
      const stored = new Map<string, unknown>();
      stored.set('queueState', {
        jobs: [['j1', { id: 'j1', batchId: 'b1', status: 'pending', priority: 1, attempts: 0, maxAttempts: 3, createdAt: Date.now(), errorCount: 0 } as QueueJob]],
        batches: [['b1', { id: 'b1', status: 'pending', totalJobs: 1, completedJobs: 0, failedJobs: 0, createdAt: Date.now(), results: [], errors: [] } as BatchJob]],
        processingQueue: [],
        retryQueue: [],
        deadLetterQueue: [],
        priorityQueues: [[1, ['j1']]],
        lastProcessedTime: Date.now(),
        processedJobsCount: 0,
      });
      const state = createMockState(stored);
      const manager = createQueueManager(state);

      // Trigger fetch to ensure state is loaded
      const res = await manager.fetch(makeRequest('/queue/stats'));
      expect(res.status).toBe(200);
      const stats = await res.json() as { totalJobs: number };
      expect(stats.totalJobs).toBe(1);
    });

    it('operates with empty state when load fails', async () => {
      const badState = createMockState();
      badState.storage.get = vi.fn(() => Promise.reject(new Error('Storage down')));
      const manager = createQueueManager(badState);

      const res = await manager.fetch(makeRequest('/queue/stats'));
      expect(res.status).toBe(200);
      const stats = await res.json() as { totalJobs: number };
      expect(stats.totalJobs).toBe(0);
    });
  });

  describe('submit batch', () => {
    it('rejects non-POST methods', async () => {
      const manager = createQueueManager();
      const res = await manager.fetch(makeRequest('/queue/submit', 'GET'));
      expect(res.status).toBe(405);
    });

    it('rejects empty requests', async () => {
      const manager = createQueueManager();
      const res = await manager.fetch(makeRequest('/queue/submit', 'POST', { requests: [] }));
      expect(res.status).toBe(400);
    });

    it('rejects batches over 100 items', async () => {
      const manager = createQueueManager();
      const requests = Array.from({ length: 101 }, (_, i) => ({ id: `r${i}`, query: { address: `${i} Main St` }, pathname: '/api/federal' }));
      const res = await manager.fetch(makeRequest('/queue/submit', 'POST', { requests }));
      expect(res.status).toBe(400);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('100');
    });

    it('submits a valid batch and returns batchId', async () => {
      const manager = createQueueManager();
      const requests = [
        { id: 'r1', query: { address: '123 Main St' }, pathname: '/api/federal' },
        { id: 'r2', query: { address: '456 Oak Ave' }, pathname: '/api/federal' },
      ];
      const res = await manager.fetch(makeRequest('/queue/submit', 'POST', { requests, priority: 2, tags: ['tag1'] }));
      expect(res.status).toBe(200);
      const body = await res.json() as { batchId: string; totalJobs: number; status: string };
      expect(body.status).toBe('submitted');
      expect(body.totalJobs).toBe(2);
      expect(body.batchId).toBeTruthy();
    });

    it('groups similar requests by pathname and query pattern', async () => {
      const manager = createQueueManager();
      const requests = [
        { id: 'r1', query: { address: '123 Main St', city: 'Ottawa' }, pathname: '/api/federal' },
        { id: 'r2', query: { address: '456 Oak Ave', city: 'Ottawa' }, pathname: '/api/federal' },
        { id: 'r3', query: { address: '789 Pine Rd' }, pathname: '/api/ontario' },
      ];
      const res = await manager.fetch(makeRequest('/queue/submit', 'POST', { requests }));
      const body = await res.json() as { groupedJobs: number };
      expect(body.groupedJobs).toBe(2);
    });
  });

  describe('get status', () => {
    it('returns batch status by batchId', async () => {
      const manager = createQueueManager();
      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };

      const res = await manager.fetch(makeRequest(`/queue/status?batchId=${batchId}`));
      expect(res.status).toBe(200);
      const batch = await res.json() as BatchJob;
      expect(batch.id).toBe(batchId);
      expect(batch.totalJobs).toBe(1);
    });

    it('returns 404 for unknown batch', async () => {
      const manager = createQueueManager();
      const res = await manager.fetch(makeRequest('/queue/status?batchId=nonexistent'));
      expect(res.status).toBe(404);
    });

    it('returns job status by jobId', async () => {
      const manager = createQueueManager();
      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };
      const jobId = `${batchId}_job_0`;

      const res = await manager.fetch(makeRequest(`/queue/status?jobId=${jobId}`));
      expect(res.status).toBe(200);
      const job = await res.json() as QueueJob;
      expect(job.id).toBe(jobId);
    });
  });

  describe('process jobs', () => {
    it('rejects non-POST methods', async () => {
      const manager = createQueueManager();
      const res = await manager.fetch(makeRequest('/queue/process'));
      expect(res.status).toBe(405);
    });

    it('processes pending jobs and marks them completed', async () => {
      const manager = createQueueManager();
      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [
          { id: 'r1', query: { address: 'A' }, pathname: '/api/federal' },
          { id: 'r2', query: { address: 'B' }, pathname: '/api/federal' },
        ]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };

      const processRes = await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 2 }));
      expect(processRes.status).toBe(200);
      const body = await processRes.json() as { processedJobs: number; results: Array<{ status: string }> };
      expect(body.processedJobs).toBe(2);
      expect(body.results.every(r => r.status === 'completed')).toBe(true);

      // Batch should be completed
      const batchRes = await manager.fetch(makeRequest(`/queue/batch?id=${batchId}`));
      const batch = await batchRes.json() as BatchJob;
      expect(batch.status).toBe('completed');
      expect(batch.completedJobs).toBe(2);
    });

    it('respects maxJobs limit and clamps out-of-range values', async () => {
      const manager = createQueueManager();
      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, query: { address: `${i}` }, pathname: '/api/federal' }))
      }));

      const processRes = await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 2 }));
      const body = await processRes.json() as { processedJobs: number };
      expect(body.processedJobs).toBe(2);
    });

    it('retries failed jobs up to maxAttempts then moves to dead letter', async () => {
      const manager = createQueueManager();
      // Force every job to fail
      (manager as unknown as Record<string, unknown>).processJob = async () => {
        throw new Error('Simulated failure');
      };

      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };

      // Process 5 times (maxAttempts = 5); 5th failure moves to dead letter
      for (let i = 0; i < 5; i++) {
        await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));
      }

      // Job should now be in dead letter queue
      const dlRes = await manager.fetch(makeRequest('/queue/dead-letter'));
      const dlBody = await dlRes.json() as { total: number; deadLetterJobs: Array<{ id: string }> };
      expect(dlBody.total).toBe(1);
      expect(dlBody.deadLetterJobs[0].id).toContain(batchId);

      // Processing again should yield no results since job is in dead letter
      const res6 = await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));
      const body6 = await res6.json() as { processedJobs: number; results: unknown[] };
      expect(body6.processedJobs).toBe(0);
      expect(body6.results.length).toBe(0);
    });

    it('processes retry queue before new jobs', async () => {
      const manager = createQueueManager();
      (manager as unknown as Record<string, unknown>).processJob = async (job: QueueJob) => {
        if (job.attempts === 1) throw new Error('fail once');
        return { id: job.request.id, query: job.request.query, point: { lon: 0, lat: 0 }, properties: {}, processingTime: 10 };
      };

      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));

      // First process: fails and goes to retry queue
      await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));

      // Add a second job
      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r2', query: { address: 'B' }, pathname: '/api/federal' }]
      }));

      // Second process with maxJobs=1 should pick from retry queue first
      const res2 = await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));
      const body2 = await res2.json() as { results: Array<{ jobId: string; status: string }> };
      expect(body2.results[0].status).toBe('completed');
      // The retried job should be j1 (first batch)
      expect(body2.results[0].jobId).toContain('_job_0');
    });
  });

  describe('retry failed jobs', () => {
    it('resets failed jobs back to pending', async () => {
      const manager = createQueueManager();
      (manager as unknown as Record<string, unknown>).processJob = async () => {
        throw new Error('fail');
      };

      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };

      // Fail once
      await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));

      const jobId = `${batchId}_job_0`;
      const retryRes = await manager.fetch(makeRequest('/queue/retry', 'POST', { jobIds: [jobId] }));
      expect(retryRes.status).toBe(200);
      const body = await retryRes.json() as { retriedCount: number };
      expect(body.retriedCount).toBe(1);

      // Job should be pending again
      const statusRes = await manager.fetch(makeRequest(`/queue/job?id=${jobId}`));
      const job = await statusRes.json() as QueueJob;
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
    });
  });

  describe('dead letter queue', () => {
    it('lists dead letter jobs with pagination', async () => {
      const manager = createQueueManager();
      (manager as unknown as Record<string, unknown>).processJob = async () => {
        throw new Error('fail');
      };

      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, query: { address: `${i}` }, pathname: '/api/federal' }))
      }));

      // Exhaust all retries
      for (let i = 0; i < 6; i++) {
        await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 3 }));
      }

      const dlRes = await manager.fetch(makeRequest('/queue/dead-letter?limit=2&offset=0'));
      const dlBody = await dlRes.json() as { total: number; deadLetterJobs: unknown[]; limit: number; offset: number };
      expect(dlBody.total).toBe(3);
      expect(dlBody.deadLetterJobs.length).toBe(2);
      expect(dlBody.limit).toBe(2);
      expect(dlBody.offset).toBe(0);
    });

    it('retries dead letter jobs and moves them back to priority queue', async () => {
      const manager = createQueueManager();
      (manager as unknown as Record<string, unknown>).processJob = async () => {
        throw new Error('fail');
      };

      const submitRes = await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));
      const { batchId } = await submitRes.json() as { batchId: string };

      // Exhaust retries
      for (let i = 0; i < 6; i++) {
        await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));
      }

      const jobId = `${batchId}_job_0`;
      const retryRes = await manager.fetch(makeRequest('/queue/retry-dead-letter', 'POST', { jobIds: [jobId], resetAttempts: true, newPriority: 5 }));
      expect(retryRes.status).toBe(200);
      const body = await retryRes.json() as { retriedCount: number; results: Array<{ status: string; priority?: number }> };
      expect(body.retriedCount).toBe(1);
      expect(body.results[0].status).toBe('retried');
      expect(body.results[0].priority).toBe(5);

      // DLQ should be empty
      const dlRes = await manager.fetch(makeRequest('/queue/dead-letter'));
      const dlBody = await dlRes.json() as { total: number };
      expect(dlBody.total).toBe(0);
    });
  });

  describe('stats and health', () => {
    it('returns accurate stats', async () => {
      const manager = createQueueManager();
      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [
          { id: 'r1', query: { address: 'A' }, pathname: '/api/federal' },
          { id: 'r2', query: { address: 'B' }, pathname: '/api/federal' },
        ]
      }));

      const statsRes = await manager.fetch(makeRequest('/queue/stats'));
      const stats = await statsRes.json() as { totalJobs: number; pendingJobs: number };
      expect(stats.totalJobs).toBe(2);
      expect(stats.pendingJobs).toBe(2);

      // Process one
      await manager.fetch(makeRequest('/queue/process', 'POST', { maxJobs: 1 }));
      const statsRes2 = await manager.fetch(makeRequest('/queue/stats'));
      const stats2 = await statsRes2.json() as { completedJobs: number; pendingJobs: number };
      expect(stats2.completedJobs).toBe(1);
      expect(stats2.pendingJobs).toBe(1);
    });

    it('returns health check with queue lengths', async () => {
      const manager = createQueueManager();
      await manager.fetch(makeRequest('/queue/submit', 'POST', {
        requests: [{ id: 'r1', query: { address: 'A' }, pathname: '/api/federal' }]
      }));

      const healthRes = await manager.fetch(makeRequest('/queue/health'));
      expect(healthRes.status).toBe(200);
      const health = await healthRes.json() as { status: string; queueLengths: { processing: number } };
      expect(health.status).toBe('healthy');
      expect(health.queueLengths.processing).toBe(0);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const manager = createQueueManager();
      const res = await manager.fetch(makeRequest('/queue/unknown'));
      expect(res.status).toBe(404);
    });
  });
});
