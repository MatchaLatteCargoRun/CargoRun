'use strict';

(function exposeCentralSyncScheduler(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CargoRunCentralSyncScheduler = api;
})(typeof globalThis === 'object' ? globalThis : this, function buildCentralSyncScheduler() {
  const CADENCE_MS = Object.freeze({
    operational: 10000,
    home: 20000,
    dashboard: 15000,
    idle: 120000
  });
  const BACKOFF_MS = Object.freeze([20000, 30000, 60000, 120000]);

  function cadenceFor(screen, activeFlightCount) {
    if (screen === 'history' || screen === 'admin') return null;
    if (Number(activeFlightCount) === 0) return CADENCE_MS.idle;
    if (screen === 'home' || screen === 'more') return CADENCE_MS.home;
    if (screen === 'flightboard' || screen === 'supervisor' || screen === 'machfow') return CADENCE_MS.dashboard;
    return CADENCE_MS.operational;
  }

  function mergeRequests(current, incoming) {
    if (!current) return { ...incoming };
    const services = [...new Set([...(current.services || []), ...(incoming.services || [])])];
    return {
      ...current,
      ...incoming,
      automatic: current.automatic === true && incoming.automatic === true,
      quiet: current.quiet !== false && incoming.quiet !== false,
      full: current.full === true || incoming.full === true,
      includeHistory: current.includeHistory === true || incoming.includeHistory === true,
      includeCompletions: current.includeCompletions === true || incoming.includeCompletions === true,
      ...(services.length ? { services } : {})
    };
  }

  function createCentralSyncScheduler(options) {
    if (!options || typeof options.sync !== 'function') throw new TypeError('A central sync function is required');
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const canRun = options.canRun || (() => true);
    const isVisible = options.isVisible || (() => true);
    const getCadence = options.getCadence || (() => CADENCE_MS.operational);
    const onError = options.onError || (() => {});
    let timer = null;
    let started = false;
    let inFlight = null;
    let queued = null;
    let consecutiveFailures = 0;
    let lastScheduledDelay = null;

    function cancelTimer() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      lastScheduledDelay = null;
    }

    function nextDelay() {
      if (consecutiveFailures > 0) {
        return BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
      }
      return getCadence();
    }

    function schedule(delay = nextDelay()) {
      cancelTimer();
      if (!started || inFlight || !canRun() || !isVisible() || delay == null) return null;
      lastScheduledDelay = delay;
      timer = setTimer(() => {
        timer = null;
        lastScheduledDelay = null;
        void request({ automatic: true, reason: 'scheduled' });
      }, delay);
      return timer;
    }

    async function runChain(initialRequest) {
      let requestOptions = initialRequest;
      let result = false;
      while (requestOptions) {
        const automatic = requestOptions.automatic === true;
        try {
          result = await options.sync(requestOptions) === true;
        } catch (error) {
          result = false;
          onError(error);
        }
        if (result) consecutiveFailures = 0;
        else if (automatic) consecutiveFailures++;
        requestOptions = queued;
        queued = null;
      }
      return result;
    }

    function request(requestOptions = {}) {
      const normalized = { ...requestOptions, automatic: requestOptions.automatic === true };
      const coalesceIfBusy = normalized.coalesceIfBusy === true;
      delete normalized.coalesceIfBusy;
      if (!canRun() || (normalized.automatic && !isVisible())) return Promise.resolve(false);
      if (inFlight) {
        if (!normalized.automatic || coalesceIfBusy) queued = mergeRequests(queued, normalized);
        return inFlight;
      }
      cancelTimer();
      inFlight = runChain(normalized).finally(() => {
        inFlight = null;
        if (started) schedule();
      });
      return inFlight;
    }

    function start({ immediate = false } = {}) {
      started = true;
      if (immediate) return request({ automatic: true, reason: 'start' });
      schedule();
      return Promise.resolve(true);
    }

    function stop() {
      started = false;
      queued = null;
      cancelTimer();
    }

    function reschedule() {
      if (!started) return null;
      return schedule();
    }

    function handleVisibilityChange({ refresh = true } = {}) {
      cancelTimer();
      if (!started || !isVisible() || !canRun()) return Promise.resolve(false);
      if (!refresh) {
        schedule();
        return Promise.resolve(true);
      }
      return request({ automatic: true, reason: 'visibility', coalesceIfBusy: true });
    }

    function inspect() {
      return {
        started,
        timerActive: timer !== null,
        inFlight: inFlight !== null,
        queued: queued !== null,
        consecutiveFailures,
        lastScheduledDelay,
        nextDelay: nextDelay()
      };
    }

    return { start, stop, request, reschedule, handleVisibilityChange, inspect };
  }

  return { CADENCE_MS, BACKOFF_MS, cadenceFor, createCentralSyncScheduler };
});
