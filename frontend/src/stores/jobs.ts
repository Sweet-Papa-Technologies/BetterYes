import { defineStore } from 'pinia';
import type { Escalation, Job, JobEvent } from '@foreman/shared';
import { api, connectWs } from '../lib/api';
import { isActive, needsYou } from '../lib/status';

interface JobsState {
  jobs: Record<string, Job>;
  live: boolean;
  loaded: boolean;
  boardDisconnect: (() => void) | null;
  // open escalations awaiting a human
  escalations: Escalation[];
  // currently-open job detail
  detailId: string | null;
  detailEvents: JobEvent[];
  detailDisconnect: (() => void) | null;
}

export const useJobsStore = defineStore('jobs', {
  state: (): JobsState => ({
    jobs: {},
    live: false,
    loaded: false,
    boardDisconnect: null,
    escalations: [],
    detailId: null,
    detailEvents: [],
    detailDisconnect: null,
  }),

  getters: {
    list: (s): Job[] =>
      Object.values(s.jobs).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    running(): Job[] {
      return this.list.filter((j) => j.state === 'running' || j.state === 'planning');
    },
    needsYouJobs(): Job[] {
      return this.list.filter((j) => needsYou(j.state));
    },
    topEscalation(): Escalation | null {
      return this.escalations[0] ?? null;
    },
    activeCount(): number {
      return this.list.filter((j) => isActive(j.state)).length;
    },
    doneCount(): number {
      return this.list.filter((j) => j.state === 'done').length;
    },
    summary(): { running: number; needsYou: number; done: number } {
      return {
        running: this.running.length,
        needsYou: this.needsYouJobs.length,
        done: this.doneCount,
      };
    },
  },

  actions: {
    async loadAndSubscribe() {
      const jobs = await api.listJobs();
      this.jobs = Object.fromEntries(jobs.map((j) => [j.id, j]));
      this.loaded = true;
      await this.refreshEscalations();
      this.boardDisconnect?.();
      this.boardDisconnect = connectWs(
        '/ws/jobs',
        (m) => {
          if (m.kind === 'job') {
            const prev = this.jobs[m.job.id];
            this.jobs[m.job.id] = m.job;
            // A job's open-question count changing means escalations opened/closed.
            if (!prev || prev.openQuestions !== m.job.openQuestions || m.job.state === 'blocked') {
              void this.refreshEscalations();
            }
          }
        },
        (live) => (this.live = live),
      );
    },

    async refreshEscalations() {
      try {
        this.escalations = await api.escalations('open');
      } catch {
        /* unauthorized / daemon down */
      }
    },

    async resolveEscalation(id: string, decision: 'allow' | 'deny', answer?: string) {
      await api.resolveEscalation(id, decision, answer);
      this.escalations = this.escalations.filter((e) => e.id !== id);
    },

    async openDetail(id: string) {
      this.closeDetail();
      this.detailId = id;
      this.detailEvents = [];
      this.detailDisconnect = connectWs(
        `/ws/jobs/${id}/stream`,
        (m) => {
          if (m.kind === 'snapshot') {
            this.jobs[m.job.id] = m.job;
            this.detailEvents = m.events;
          } else if (m.kind === 'event' && m.event.jobId === id) {
            this.detailEvents.push(m.event);
          } else if (m.kind === 'job') {
            this.jobs[m.job.id] = m.job;
          }
        },
        (live) => (this.live = live),
      );
    },

    closeDetail() {
      this.detailDisconnect?.();
      this.detailDisconnect = null;
      this.detailId = null;
      this.detailEvents = [];
    },

    job(id: string): Job | undefined {
      return this.jobs[id];
    },
  },
});
