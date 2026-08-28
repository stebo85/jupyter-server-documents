// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { Notification } from '@jupyterlab/apputils';
import { PageConfig } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

// The executor is the only plugin under test here. Its sibling plugins pull
// in ESM-only dependencies that this repository's Jest transform does not
// cover, so stub them out rather than loading the whole extension.
jest.mock('../docprovider', () => ({ jsdDocumentProviderFactory: {} }));
jest.mock('../disablesave', () => ({ disableSavePlugin: {} }));
jest.mock('../outputs', () => ({ outputsServicePlugin: {} }));

import { serverCellExecutorPlugin } from '../index';

/**
 * Tests for the trust granted by the server-side cell executor.
 *
 * The server-side path bypasses `CodeCellModel.clearExecution()`, which is
 * where the default executor marks a user-executed cell trusted. This
 * executor grants that trust itself, so it must grant it *only* when
 * execution is actually dispatched: the method has several early returns
 * that execute nothing, and it never clears the cell's outputs, so trusting
 * on those paths would retroactively trust output loaded from an untrusted
 * notebook.
 */

function makeCell(options: { type?: string; trusted?: boolean } = {}): any {
  return {
    model: {
      type: options.type ?? 'code',
      trusted: options.trusted ?? false,
      sharedModel: {
        getId: () => 'cell-1',
        getSource: () => 'print(1)'
      }
    },
    isDisposed: false,
    inputHidden: false
  };
}

const notebook: any = {
  sharedModel: {
    getState: () => 'json:notebook:file-1',
    awareness: { clientID: 7 }
  }
};

/** A session context with a live kernel, so `runCell` reaches dispatch. */
function liveSessionContext(): any {
  return {
    hasNoKernel: false,
    session: { kernel: { id: 'kernel-1' }, path: 'notebook.ipynb' }
  };
}

function makeExecutor(): any {
  const app: any = {
    serviceManager: { serverSettings: ServerConnection.makeSettings() }
  };
  return serverCellExecutorPlugin.activate(app);
}

function makeCallbacks() {
  return {
    onCellExecuted: jest.fn(),
    onCellExecutionScheduled: jest.fn()
  };
}

describe('serverCellExecutorPlugin runCell trust', () => {
  let requestSpy: jest.SpyInstance;

  beforeAll(() => {
    PageConfig.setOption('serverSideExecution', 'true');
    // `crypto.randomUUID` is used to build the request ID; jsdom may not
    // provide it.
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => 'request-1' },
      configurable: true,
      writable: true
    });
  });

  beforeEach(() => {
    requestSpy = jest.spyOn(ServerConnection, 'makeRequest');
    jest.spyOn(Notification, 'warning').mockImplementation(() => '');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('grants trust when execution is dispatched successfully', async () => {
    requestSpy.mockResolvedValue({ ok: true, status: 200 } as any);
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext: liveSessionContext(),
      ...callbacks
    });

    expect(result).toBe(true);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(cell.model.trusted).toBe(true);
  });

  it('does not grant trust when there is no session context', async () => {
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext: undefined,
      ...callbacks
    });

    expect(result).toBe(true);
    // Nothing was dispatched, so nothing may be trusted.
    expect(cell.model.trusted).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(callbacks.onCellExecutionScheduled).not.toHaveBeenCalled();
  });

  it('does not grant trust when no kernel is available after starting one', async () => {
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();
    // The user declines the kernel selection, so `hasNoKernel` stays true.
    const sessionContext: any = {
      hasNoKernel: true,
      startKernel: jest.fn().mockResolvedValue(false)
    };

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext,
      ...callbacks
    });

    expect(result).toBe(true);
    expect(sessionContext.startKernel).toHaveBeenCalled();
    expect(cell.model.trusted).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
    expect(callbacks.onCellExecutionScheduled).not.toHaveBeenCalled();
  });

  it('restores the previous trust state when the source hash is rejected', async () => {
    requestSpy.mockResolvedValue({ ok: false, status: 409 } as any);
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext: liveSessionContext(),
      ...callbacks
    });

    expect(result).toBe(false);
    expect(cell.model.trusted).toBe(false);
  });

  it('restores the previous trust state when the request fails', async () => {
    requestSpy.mockResolvedValue({ ok: false, status: 500 } as any);
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext: liveSessionContext(),
      ...callbacks
    });

    expect(result).toBe(false);
    expect(cell.model.trusted).toBe(false);
  });

  it('restores the previous trust state when the request throws', async () => {
    requestSpy.mockRejectedValue(new Error('network down'));
    const executor = makeExecutor();
    const cell = makeCell();
    const callbacks = makeCallbacks();

    await expect(
      executor.runCell({
        cell,
        notebook,
        sessionContext: liveSessionContext(),
        ...callbacks
      })
    ).rejects.toThrow('network down');

    expect(cell.model.trusted).toBe(false);
  });

  it('keeps an already-trusted cell trusted when the request fails', async () => {
    requestSpy.mockResolvedValue({ ok: false, status: 500 } as any);
    const executor = makeExecutor();
    // A cell from a trusted notebook must not be *downgraded* by a failure.
    const cell = makeCell({ trusted: true });
    const callbacks = makeCallbacks();

    await executor.runCell({
      cell,
      notebook,
      sessionContext: liveSessionContext(),
      ...callbacks
    });

    expect(cell.model.trusted).toBe(true);
  });

  it('does not grant trust to a markdown cell', async () => {
    const executor = makeExecutor();
    const cell = makeCell({ type: 'markdown' });
    const callbacks = makeCallbacks();

    const result = await executor.runCell({
      cell,
      notebook,
      sessionContext: liveSessionContext(),
      ...callbacks
    });

    expect(result).toBe(true);
    expect(cell.model.trusted).toBe(false);
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
