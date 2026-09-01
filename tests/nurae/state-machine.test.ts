/**
 * NURAE — bot status state machine tests (Step 8).
 */

import { describe, expect, test } from 'vitest';
import { BOT_STATUSES, canTransition, isBotStatus, legalTransitions } from '../../src/lib/nurae/runtime/state-machine';

describe('bot state machine (Step 8)', () => {
  test('happy path: STOPPED → STARTING → RUNNING → STOPPING → STOPPED', () => {
    expect(canTransition('stopped', 'starting')).toBe(true);
    expect(canTransition('starting', 'running')).toBe(true);
    expect(canTransition('running', 'stopping')).toBe(true);
    expect(canTransition('stopping', 'stopped')).toBe(true);
  });

  test('error paths: STARTING/RUNNING → ERROR, and ERROR → STARTING (retry)', () => {
    expect(canTransition('starting', 'error')).toBe(true);
    expect(canTransition('running', 'error')).toBe(true);
    expect(canTransition('stopping', 'error')).toBe(true);
    expect(canTransition('error', 'starting')).toBe(true);
    expect(canTransition('error', 'stopped')).toBe(true);
  });

  test('nonsense transitions are rejected', () => {
    expect(canTransition('stopped', 'running')).toBe(false);
    expect(canTransition('stopped', 'stopping')).toBe(false);
    expect(canTransition('running', 'starting')).toBe(false);
    expect(canTransition('running', 'stopped')).toBe(false);
    expect(canTransition('stopping', 'running')).toBe(false);
    expect(canTransition('starting', 'stopped')).toBe(false);
    expect(canTransition('error', 'running')).toBe(false);
  });

  test('unknown source states are rejected', () => {
    expect(canTransition('nonsense', 'running')).toBe(false);
    expect(canTransition('', 'running')).toBe(false);
  });

  test('every state has legal transitions defined (no dead ends)', () => {
    for (const status of BOT_STATUSES) {
      expect(legalTransitions(status).length).toBeGreaterThan(0);
    }
  });

  test('isBotStatus discriminates the five reliable states', () => {
    for (const status of BOT_STATUSES) expect(isBotStatus(status)).toBe(true);
    expect(isBotStatus('RUNNING')).toBe(false);
    expect(isBotStatus('ok')).toBe(false);
  });
});
