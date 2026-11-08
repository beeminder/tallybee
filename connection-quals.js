import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from './beeminder.js';

const getters = [api.getUser, api.getGoals];
const token = JSON.stringify({ token: 'qualification-token', user: 'alice' });
let storage, descriptor, controller;

beforeEach(() => {
  descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  storage = new Map([['beeminder-token', token]]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true,
    value: {
      getItem: key => storage.get(key) ?? null,
      removeItem: key => storage.delete(key),
    },
  });
  controller = new AbortController();
  mock.method(AbortSignal, 'timeout', () => controller.signal);
  mock.method(globalThis, 'fetch', async () => {
    throw new Error('No fetch response was specified for this qual');
  });
});

afterEach(() => {
  mock.restoreAll();
  delete globalThis.localStorage;
  if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
});

function connection(cause) {
  return error => {
    assert.equal(typeof api.ConnectionError, 'function');
    assert.ok(error instanceof api.ConnectionError);
    assert.equal(error.cause, cause);
    return true;
  };
}

function original(cause) {
  return error => {
    assert.equal(error, cause);
    assert.notEqual(error.constructor, api.ConnectionError);
    return true;
  };
}

function bodyFailure(cause) {
  return { ok: true, status: 200, json: async () => { throw cause } };
}

test('a GET rejected by the network reports a connection failure with its cause',
async () => {
  const cause = new TypeError('Failed to fetch');
  fetch.mock.mockImplementation(async () => { throw cause });
  for (const get of getters) await assert.rejects(get(), connection(cause));
});

test('a GET timeout reports a connection failure with its cause', async () => {
  const cause = new DOMException('The request timed out', 'TimeoutError');
  fetch.mock.mockImplementation(async () => { throw cause });
  for (const get of getters) await assert.rejects(get(), connection(cause));
});

test('a network failure while reading GET JSON remains a connection failure',
async () => {
  const cause = new TypeError('The response body stream failed');
  fetch.mock.mockImplementation(async () => bodyFailure(cause));
  for (const get of getters) await assert.rejects(get(), connection(cause));
});

test('a GET body aborted by its own timeout reports that connection failure',
async () => {
  const cause = new DOMException('The body read was aborted', 'AbortError');
  fetch.mock.mockImplementation(async (_url, { signal }) => {
    assert.equal(signal, controller.signal);
    return { ok: true, status: 200, json: async () => {
      controller.abort(new DOMException('The request timed out', 'TimeoutError'));
      throw cause;
    } };
  });
  for (const get of getters) await assert.rejects(get(), connection(cause));
});

test('an unrelated GET abort is not classified as a connection failure',
async () => {
  const cause = new DOMException('An unrelated cancellation', 'AbortError');
  for (const reason of [undefined, new Error('A deliberate cancellation')]) {
    controller = new AbortController();
    if (reason) controller.abort(reason);
    fetch.mock.mockImplementation(async () => { throw cause });
    for (const get of getters) await assert.rejects(get(), original(cause));
    fetch.mock.mockImplementation(async () => bodyFailure(cause));
    for (const get of getters) await assert.rejects(get(), original(cause));
  }
});

test('malformed GET JSON keeps its syntax error', async () => {
  const cause = new SyntaxError('Unexpected token in JSON');
  fetch.mock.mockImplementation(async () => bodyFailure(cause));
  for (const get of getters) await assert.rejects(get(), original(cause));
});

test('HTTP rejection stays loud and a 401 still forgets the rejected token',
async () => {
  for (const status of [401, 500]) {
    fetch.mock.mockImplementation(async () => ({
      status, ok: false, text: async () => 'Qualification rejection',
    }));
    for (const get of getters) {
      storage.set('beeminder-token', token);
      await assert.rejects(get(), error => {
        assert.notEqual(error.constructor, api.ConnectionError);
        assert.equal(error.message,
          status === 401 ? api.REAUTH : '500 Qualification rejection');
        return true;
      });
      assert.equal(storage.has('beeminder-token'), status !== 401);
    }
  }
});

test('other GET errors retain their identity and remain loud', async () => {
  const cause = new Error('An unexpected failure');
  fetch.mock.mockImplementation(async () => { throw cause });
  for (const get of getters) await assert.rejects(get(), original(cause));
  fetch.mock.mockImplementation(async () => bodyFailure(cause));
  for (const get of getters) await assert.rejects(get(), original(cause));
});
