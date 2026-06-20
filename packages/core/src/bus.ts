import { EventEmitter } from 'node:events';
import type { Job, JobEvent } from '@foreman/shared';

/**
 * In-process pub/sub bridging the orchestrator (producer) and the API WebSocket layer
 * (consumers). No external broker (NFR: no queue to babysit) — single daemon, single bus.
 */
class ForemanBus extends EventEmitter {
  emitEvent(event: JobEvent): void {
    this.emit('event', event);
    this.emit(`event:${event.jobId}`, event);
  }

  /** A job row changed (state, burn, files…) — drives the board's live rows. */
  emitJob(job: Job): void {
    this.emit('job', job);
    this.emit(`job:${job.id}`, job);
  }

  onEvent(jobId: string, fn: (e: JobEvent) => void): () => void {
    this.on(`event:${jobId}`, fn);
    return () => this.off(`event:${jobId}`, fn);
  }

  onAnyJob(fn: (j: Job) => void): () => void {
    this.on('job', fn);
    return () => this.off('job', fn);
  }

  onJob(jobId: string, fn: (j: Job) => void): () => void {
    this.on(`job:${jobId}`, fn);
    return () => this.off(`job:${jobId}`, fn);
  }
}

export const bus = new ForemanBus();
// Many concurrent jobs + WS clients can subscribe; lift the default ceiling.
bus.setMaxListeners(1000);
