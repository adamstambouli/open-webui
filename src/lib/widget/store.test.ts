import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import { widgetKey } from './events';
import { clearWidgetIfActive, finalizeWidget, runWidgetStream, widgetStates } from './store';

const KEY = widgetKey('c1', 'm1');

/** A stream we can feed frame-by-frame, so a test can abort partway through. */
const controllableStream = () => {
	const encoder = new TextEncoder();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		}
	});
	return {
		stream,
		push: (text: string) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close()
	};
};

const frame = (event: string, payload: Record<string, unknown>) =>
	`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

const stepFrame = (id: string, label: string, status: string, messageId = 'm1') =>
	frame('widget_delta', { messageId, type: 'step', id, label, status });

/** Step timings come from the real clock here, so identity is compared without them. */
const withoutTimings = (step: { id: string; label: string; status: string }) => ({
	id: step.id,
	label: step.label,
	status: step.status
});

/** Lets queued stream reads and store writes settle before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const stubFetch = (response: unknown) => {
	const fetchMock = vi.fn().mockResolvedValue(response);
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
};

beforeEach(() => {
	widgetStates.set({});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('runWidgetStream', () => {
	it('reduces a happy stream to complete, unharmed by a malformed frame', async () => {
		const source = controllableStream();
		const fetchMock = stubFetch({ ok: true, body: source.stream });
		const controller = new AbortController();

		const done = runWidgetStream('c1', 'm1', 'tok', controller.signal);

		source.push(stepFrame('parse', 'Parsing request', 'running'));
		source.push(stepFrame('parse', 'Parsing request', 'complete'));
		source.push(stepFrame('search', 'Searching docs', 'running'));
		source.push(stepFrame('search', 'Searching docs', 'running')); // exact duplicate
		source.push(
			frame('widget_delta', {
				messageId: 'm1',
				type: 'metric',
				key: 'sources',
				label: 'Sources',
				value: 5
			})
		);
		source.push('event: widget_delta\ndata: {"messageId":"m1","type":"ste\n\n'); // malformed
		source.push(stepFrame('search', 'Searching docs', 'complete'));
		source.push(frame('widget_done', { messageId: 'm1' }));
		source.close();

		await done;

		const state = get(widgetStates)[KEY];
		expect(state.status).toBe('complete');
		// Timings come from the real clock here, so identity is compared without them.
		expect(state.steps.map(withoutTimings)).toEqual([
			{ id: 'parse', label: 'Parsing request', status: 'complete' },
			{ id: 'search', label: 'Searching docs', status: 'complete' }
		]);
		// The store is what supplies the reducer's clock; check it actually did.
		for (const step of state.steps) {
			expect(step.startedAt).toBeGreaterThan(0);
			expect(step.endedAt).toBeGreaterThanOrEqual(step.startedAt!);
		}
		expect(state.metrics).toEqual({ sources: { label: 'Sources', value: 5 } });
		expect(state.finishedAt).toBeGreaterThanOrEqual(state.startedAt);

		const url = fetchMock.mock.calls[0][0] as string;
		expect(url).toContain('chat_id=c1');
		expect(url).toContain('message_id=m1');
		expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
			Authorization: 'Bearer tok'
		});
	});

	it('ignores events addressed to a different message', async () => {
		const source = controllableStream();
		stubFetch({ ok: true, body: source.stream });
		const controller = new AbortController();

		const done = runWidgetStream('c1', 'm1', 'tok', controller.signal);

		source.push(stepFrame('other', 'Someone else', 'running', 'm2'));
		source.push(stepFrame('parse', 'Parsing request', 'running'));
		source.push(frame('widget_done', { messageId: 'm2' })); // must not finish us
		source.push(frame('widget_done', { messageId: 'm1' }));
		source.close();

		await done;

		const state = get(widgetStates)[KEY];
		expect(state.status).toBe('complete');
		expect(state.steps.map(withoutTimings)).toEqual([
			{ id: 'parse', label: 'Parsing request', status: 'running' }
		]);
		expect(get(widgetStates)[widgetKey('c1', 'm2')]).toBeUndefined();
	});

	it('stops writing once aborted, and clearWidgetIfActive drops the partial state', async () => {
		const source = controllableStream();
		stubFetch({ ok: true, body: source.stream });
		const controller = new AbortController();

		const done = runWidgetStream('c1', 'm1', 'tok', controller.signal);

		source.push(stepFrame('parse', 'Parsing request', 'complete'));
		await flush();
		const beforeAbort = get(widgetStates)[KEY];
		expect(beforeAbort.steps).toHaveLength(1);

		controller.abort();
		source.push(stepFrame('search', 'Searching docs', 'running'));
		source.push(frame('widget_done', { messageId: 'm1' }));
		source.close();

		await done; // an abort is not an error — it resolves

		expect(get(widgetStates)[KEY]).toEqual(beforeAbort);

		clearWidgetIfActive('c1', 'm1');
		expect(get(widgetStates)[KEY]).toBeUndefined();
	});

	it('never touches the store or the network for an already-aborted signal', async () => {
		const fetchMock = stubFetch({ ok: true, body: controllableStream().stream });
		const controller = new AbortController();
		controller.abort();

		await runWidgetStream('c1', 'm1', 'tok', controller.signal);

		expect(get(widgetStates)[KEY]).toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('surfaces a non-ok response as an error state', async () => {
		stubFetch({ ok: false, status: 403, body: null });

		await runWidgetStream('c1', 'm1', 'tok', new AbortController().signal);

		const state = get(widgetStates)[KEY];
		expect(state.status).toBe('error');
		expect(state.finishedAt).toBeDefined();
	});

	it('resets prior state when asked to restart the same key', async () => {
		const source = controllableStream();
		stubFetch({ ok: true, body: source.stream });

		widgetStates.set({
			[KEY]: {
				status: 'complete',
				steps: [{ id: 'stale', label: 'Stale', status: 'complete' }],
				metrics: {},
				startedAt: 1,
				finishedAt: 2
			}
		});

		const done = runWidgetStream('c1', 'm1', 'tok', new AbortController().signal, { reset: true });
		await flush();

		const restarted = get(widgetStates)[KEY];
		expect(restarted.status).toBe('starting');
		expect(restarted.steps).toEqual([]);
		expect(restarted.finishedAt).toBeUndefined();

		source.push(frame('widget_done', { messageId: 'm1' }));
		source.close();
		await done;
	});
});

describe('finalizeWidget / clearWidgetIfActive', () => {
	it('finalizes only non-terminal state that exists', () => {
		finalizeWidget('c1', 'm1', 'complete');
		expect(get(widgetStates)[KEY]).toBeUndefined(); // nothing to finalize

		widgetStates.set({
			[KEY]: { status: 'streaming', steps: [], metrics: {}, startedAt: 1 }
		});
		finalizeWidget('c1', 'm1', 'complete');
		expect(get(widgetStates)[KEY].status).toBe('complete');
		expect(get(widgetStates)[KEY].endedAt).toBeDefined();

		finalizeWidget('c1', 'm1', 'error'); // already terminal — must not downgrade
		expect(get(widgetStates)[KEY].status).toBe('complete');
	});

	it('stamps endedAt separately from the stream, which finished much earlier', () => {
		// The scripted stream ends at widget_done; the answer keeps going for far longer,
		// and it is the generation ending that ends the session and stops the timer.
		widgetStates.set({
			[KEY]: { status: 'complete', steps: [], metrics: {}, startedAt: 1, finishedAt: 2 }
		});

		finalizeWidget('c1', 'm1', 'complete');

		const state = get(widgetStates)[KEY];
		expect(state.status).toBe('complete');
		expect(state.finishedAt).toBe(2); // the stream's own end is left alone
		expect(state.endedAt).toBeGreaterThan(2);
	});

	it('is write-once, so a level-triggered caller can re-run it safely', () => {
		// The component checks "generation done and unstamped?" on every update rather
		// than trying to catch the single moment `done` flips — so this runs repeatedly.
		widgetStates.set({
			[KEY]: { status: 'complete', steps: [], metrics: {}, startedAt: 1, finishedAt: 2 }
		});

		finalizeWidget('c1', 'm1', 'complete');
		const first = get(widgetStates)[KEY].endedAt;

		finalizeWidget('c1', 'm1', 'complete');
		finalizeWidget('c1', 'm1', 'error');

		expect(get(widgetStates)[KEY].endedAt).toBe(first);
		expect(get(widgetStates)[KEY].status).toBe('complete');
	});

	it('keeps a stream error even when the generation ends cleanly', () => {
		widgetStates.set({
			[KEY]: { status: 'error', steps: [], metrics: {}, startedAt: 1, finishedAt: 2 }
		});

		finalizeWidget('c1', 'm1', 'complete');

		expect(get(widgetStates)[KEY].status).toBe('error');
	});

	it('clears endedAt when a reset restarts the same key', async () => {
		// Continue-response restarts the session; the previous end must not linger and
		// freeze the timer at the old duration.
		const source = controllableStream();
		stubFetch({ ok: true, body: source.stream });
		widgetStates.set({
			[KEY]: {
				status: 'complete',
				steps: [],
				metrics: {},
				startedAt: 1,
				finishedAt: 2,
				endedAt: 3
			}
		});

		const done = runWidgetStream('c1', 'm1', 'tok', new AbortController().signal, { reset: true });
		await flush();

		expect(get(widgetStates)[KEY].endedAt).toBeUndefined();

		source.push(frame('widget_done', { messageId: 'm1' }));
		source.close();
		await done;
	});

	it('keeps terminal snapshots when clearing', () => {
		widgetStates.set({
			[KEY]: { status: 'complete', steps: [], metrics: {}, startedAt: 1, finishedAt: 2 }
		});
		clearWidgetIfActive('c1', 'm1');
		expect(get(widgetStates)[KEY]).toBeDefined();
	});
});
